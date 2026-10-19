// Answering the node's contacts: one reply per newest inbound message, one answer per request.
//
// A webhook names a thread or a request; reconciling walks list_pending and get_inbox, over every
// account for a sweep and over one when the wait_for_updates loop (watch.ts) says something moved
// in it. Threads end in answerThread, which replies only when the thread's newest message is the
// contact's, under a msg_id derived from that message's id (read_thread's message_id, the node's
// msg_id for it, unique per account, contact and direction). The node records one row per
// (account, contact, direction, msg_id); a replay writes nothing and answers the original row's
// result (messaging.Service.Record), so a webhook and a reconcile pass, or two processes, that both
// reach one message record one reply, whatever else changed in the thread in between. A message
// without an id is not answered: the node this agent needs names every one.
//
// A thread whose contact's side is an agent too would otherwise be answered for as long as both
// agents run. agentTurns counts the turns since the last message labelled as a person's, and at
// the configured cap the thread is left alone until a person writes in it. The label is the one
// the contact's side claims, so a budget that reads no label (budget.ts) bounds the drafts for each
// contact as well: it is checked before read_thread, so a thread over it stays unread for the owner.
//
// By default only a trusted contact is answered: one whose trust flag the owner set to may_instruct
// (list_contacts' trust_flag for a thread, list_pending's TrustFlag for a request). The node's own
// reading of the flag is the same: may_instruct threads may be acted on, messages_only ones are
// raised to the person (ownermcp watch.go). Anything but may_instruct is not trusted. A thread is
// judged before read_thread, so an untrusted contact's message stays unread for the owner.
// HDTP_AGENT_ANSWER=all answers every active contact instead. The flag decides only whether to
// answer: this agent has no tools and can only write a message, so it is not shown to the model.
//
// The agent answers only what arrived after it first started (first-start.ts): a thread whose
// newest message (get_inbox's last_at, which the node sets to its newest message's time) is older
// is the owner's backlog, and is left unread for them. The cutoff is decided before read_thread.
// It is not applied to requests: an open request is a caller waiting now, and it expires.
//
// read_thread marks the thread read before the model has drafted anything. A thread whose draft
// or send failed is therefore kept here and revisited by the next reconcile pass, up to
// MAX_ATTEMPTS times; a process that stops in between loses it, because the node no longer
// counts it unread. A request stays in list_pending until it is answered or expires, so each
// reconcile pass reaches an unanswered one again.

import { createHash } from 'node:crypto'
import type { Log } from './log.ts'
import { NodeRefusal, refusalCode, type InboxThread, type NodeClient, type PendingRequest, type ThreadMessage } from './node.ts'
import { Bounded } from './bounded.ts'
import { requestPrompt, threadPrompt } from './prompt.ts'
import { Budget } from './budget.ts'
import type { Answer } from './config.ts'

/** Writes the reply text for a prompt. The model behind it has no tools. */
export type Draft = (prompt: string) => Promise<string>

/**
 * How many attempts one inbound message or one request gets: the first from the webhook or the
 * pass that found it, then one more on each reconcile pass while the last one failed.
 */
export const MAX_ATTEMPTS = 3
/** How many replied keys are remembered before the oldest is forgotten (the node still dedups). */
export const REMEMBERED = 10_000

/** The msg_id of the reply to a contact's message, by the message's id: the same from every path that reaches it. */
export function replyKey(accountId: string, contactFpr: string, messageId: string): string {
  const h = createHash('sha256')
  for (const part of [accountId, contactFpr, messageId]) {
    h.update(part).update('\0')
  }
  return `agent-reply-${h.digest('hex').slice(0, 32)}`
}

/**
 * Agent-to-agent turns at the end of a thread: outbound messages labelled 'agent' that answer an
 * inbound message labelled 'agent', counted back from the newest message to the newest message
 * labelled 'human' in either direction (the contact's person, or the owner in the portal).
 */
export function agentTurns(messages: readonly ThreadMessage[]): number {
  let turns = 0
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i]!
    if (m.sender === 'human') break
    const answered = messages[i - 1]!
    if (m.direction === 'out' && answered.direction === 'in' && answered.sender === 'agent') turns++
  }
  return turns
}

/** The trust flag of a contact this agent answers when it answers trusted contacts only. */
export const TRUSTED = 'may_instruct'

/** What decides whether to draft. */
export interface Rules {
  /** Which contacts are answered (HDTP_AGENT_ANSWER). */
  answer: Answer
  /** Agent-to-agent turns in a row a thread may have (HDTP_AGENT_TURN_CAP). */
  turnCap: number
  /** Drafts per contact per hour, whatever the labels say (HDTP_AGENT_REPLIES_PER_HOUR). */
  repliesPerHour: number
  /** Unix seconds: the agent's first start. A thread whose newest message is older is left to the owner. */
  firstStart: number
  /** Unix seconds now. */
  now: () => number
}

/** The budget's key for a contact of an account. */
const contactKey = (accountId: string, contactFpr: string) => `${accountId}\0${contactFpr}`

export class Responder {
  /** Keys of replies sent (msg_ids) and of requests answered. */
  private readonly done = new Bounded<true>(REMEMBERED)
  /** Attempts per key that has not succeeded. */
  private readonly attempts = new Bounded<number>(REMEMBERED)
  /** Threads (account \0 thread) to revisit on the next reconcile pass. */
  private readonly revisit = new Bounded<true>(REMEMBERED)
  /** Work in flight by key, and whether another call asked for it while it ran. */
  private readonly running = new Map<string, { again: boolean }>()

  private readonly node: NodeClient
  private readonly draft: Draft
  private readonly log: Log
  private readonly turnCap: number
  private readonly answer: Answer
  private readonly firstStart: number
  private readonly budget: Budget

  constructor(node: NodeClient, draft: Draft, log: Log, rules: Rules) {
    this.node = node
    this.draft = draft
    this.log = log
    this.turnCap = rules.turnCap
    this.answer = rules.answer
    this.firstStart = rules.firstStart
    this.budget = new Budget(rules.repliesPerHour, rules.now)
  }

  /** A webhook's message.received: the thread it names, in whichever account holds it. */
  async onMessage(threadId: string): Promise<void> {
    for (const accountId of await this.node.listAccounts()) {
      const row = (await this.node.getInbox(accountId)).find((t) => t.thread_id === threadId)
      if (row) return this.answerThread(accountId, row)
    }
    this.log.info('thread_not_held', { thread_id: threadId })
  }

  /** A webhook's request.pending: the request it names, in whichever account holds it. */
  async onRequest(requestId: string): Promise<void> {
    for (const accountId of await this.node.listAccounts()) {
      const row = (await this.node.listPending(accountId)).find((r) => r.ID === requestId)
      if (row) return this.answerRequest(accountId, row)
    }
    this.log.info('request_not_open', { request_id: requestId })
  }

  /**
   * One pass over every account. `listed`, when given, is handed the accounts before the pass
   * works through them.
   */
  async reconcile(listed?: (accounts: string[]) => void): Promise<void> {
    const accounts = await this.node.listAccounts()
    listed?.(accounts)
    for (const accountId of accounts) await this.reconcileAccount(accountId)
  }

  /**
   * One pass over one account: its open requests first, since a caller is waiting on each, then
   * its unread threads and the threads a failure left to revisit. A section that fails is logged
   * by code and the pass goes on, so a failing list_pending does not keep threads unanswered.
   */
  async reconcileAccount(accountId: string): Promise<void> {
    await this.section('list_pending', async () => {
      for (const row of await this.node.listPending(accountId)) {
        await this.answerRequest(accountId, row)
      }
    })
    await this.section('get_inbox', async () => {
      for (const row of await this.node.getInbox(accountId)) {
        if (row.unread > 0 || this.revisit.has(`${accountId}\0${row.thread_id}`)) {
          await this.answerThread(accountId, row)
        }
      }
    })
  }

  private async section(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (e) {
      this.log.warn('reconcile_failed', { section: name, reason: refusalCode(e) })
    }
  }

  /** Runs `work` once per key at a time; a call that arrives meanwhile makes it run once more. */
  private async single(key: string, work: () => Promise<void>): Promise<void> {
    const held = this.running.get(key)
    if (held) {
      held.again = true
      return
    }
    const state = { again: false }
    this.running.set(key, state)
    try {
      do {
        state.again = false
        await work()
      } while (state.again)
    } finally {
      this.running.delete(key)
    }
  }

  async answerThread(accountId: string, row: InboxThread): Promise<void> {
    const where = `${accountId}\0${row.thread_id}`
    if (row.contact_status !== 'active') {
      this.revisit.delete(where)
      this.log.info('contact_not_active', { thread_id: row.thread_id, status: row.contact_status })
      return
    }
    if (row.last_at < this.firstStart) {
      this.revisit.delete(where)
      this.log.info('before_first_start', { thread_id: row.thread_id })
      return
    }
    const contact = contactKey(accountId, row.contact_fpr)
    await this.single(where, async () => {
      if (this.answer === 'trusted') {
        const c = (await this.node.listContacts(accountId)).find((x) => x.fingerprint === row.contact_fpr)
        if (c?.trust_flag !== TRUSTED) {
          this.revisit.delete(where)
          this.log.info('contact_not_trusted', { thread_id: row.thread_id })
          return
        }
      }
      if (!this.budget.room(contact)) {
        // Kept to revisit, if it was: a thread a failed draft left read is answered once the
        // hour moves on, as an unread one is.
        this.log.info('contact_budget', { thread_id: row.thread_id })
        return
      }
      const messages = await this.node.readThread(accountId, row.thread_id)
      const newest = messages.at(-1)
      if (!newest || newest.direction !== 'in') {
        this.revisit.delete(where)
        return
      }
      if (typeof newest.message_id !== 'string' || newest.message_id === '') {
        this.revisit.delete(where)
        this.log.warn('message_id_missing', { thread_id: row.thread_id })
        return
      }
      const key = replyKey(accountId, row.contact_fpr, newest.message_id)
      if (this.done.has(key)) {
        this.revisit.delete(where)
        return
      }
      const turns = agentTurns(messages)
      if (turns >= this.turnCap) {
        this.revisit.delete(where)
        this.log.info('agent_turn_cap', { thread_id: row.thread_id, turns })
        return
      }
      await this.attempt(key, where, { thread_id: row.thread_id }, async () => {
        const text = await this.write(contact, threadPrompt(messages))
        await this.node.sendToContact({
          account_id: accountId,
          contact_fpr: row.contact_fpr,
          thread_id: row.thread_id,
          msg_id: key,
          text,
        })
        this.log.info('replied', { thread_id: row.thread_id, msg_id: key })
      })
    })
  }

  async answerRequest(accountId: string, row: PendingRequest): Promise<void> {
    const key = `request\0${accountId}\0${row.ID}`
    const contact = contactKey(accountId, row.ContactFpr)
    await this.single(key, async () => {
      if (this.done.has(key)) return
      if (this.answer === 'trusted' && row.TrustFlag !== TRUSTED) {
        this.log.info('contact_not_trusted', { request_id: row.ID })
        return
      }
      if (!this.budget.room(contact)) {
        this.log.info('contact_budget', { request_id: row.ID })
        return
      }
      await this.attempt(key, null, { request_id: row.ID }, async () => {
        const result = await this.write(contact, requestPrompt(row))
        await this.node.answerRequest({ account_id: accountId, request_id: row.ID, result })
        this.log.info('answered', { request_id: row.ID })
      })
    })
  }

  /**
   * The model's text for a prompt, counted against the contact's budget; a failure or an empty text
   * is a refusal named draft. The budget was checked before the work began, and is checked again
   * here, where it is spent, for drafts of one contact that ran side by side.
   */
  private async write(contact: string, prompt: string): Promise<string> {
    if (!this.budget.take(contact)) throw new NodeRefusal('draft', 'contact_budget')
    let text: string
    try {
      text = (await this.draft(prompt)).trim()
    } catch {
      throw new NodeRefusal('draft', 'model_failed')
    }
    if (!text) throw new NodeRefusal('draft', 'empty')
    return text
  }

  /** Runs one attempt for a key, counting it, and keeps the thread to revisit while attempts remain. */
  private async attempt(
    key: string,
    where: string | null,
    ids: Record<string, string>,
    work: () => Promise<void>,
  ): Promise<void> {
    const n = (this.attempts.get(key) ?? 0) + 1
    if (n > MAX_ATTEMPTS) {
      if (where) this.revisit.delete(where)
      return
    }
    this.attempts.set(key, n)
    try {
      await work()
      this.done.set(key, true)
      this.attempts.delete(key)
      if (where) this.revisit.delete(where)
    } catch (e) {
      const last = n >= MAX_ATTEMPTS
      this.log.warn(last ? 'gave_up' : 'attempt_failed', { ...ids, reason: refusalCode(e), attempt: n })
      if (where) {
        if (last) this.revisit.delete(where)
        else this.revisit.set(where, true)
      }
    }
  }
}
