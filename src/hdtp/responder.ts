// Answering the node's contacts: one turn per newest inbound message, one answer per request.
//
// A turn (turn.ts) is a reply to the contact, an ask for the owner, a notice for the owner after an
// optional reply, or none. An ask is put with ask_owner, keyed on the message it is about; while any
// ask of a thread is open the thread is not drafted for, and it is checked before read_thread, so a
// contact's newer message stays unread for the owner. The node holds the ask, so the hold survives a
// restart: every visit reads list_asks first. When the owner taps a ready reply or writes their own,
// the node sends it to the contact as the owner's message, and the thread's newest message is then
// this side's. An ask that is no longer open while its message is still the newest (answered with no
// message, withdrawn or expired) is drafted for once more, with what became of it quoted to the
// model, and a reply, notice or none is offered then, not another ask. That redraft does not survive
// a restart: the threads with an open ask are kept in memory (waiting), and after a restart a read
// thread is visited again only when it moves, so an ask that ends after a restart, or ended just
// before one, gets no redraft; the thread's next contact message is answered as any other. none sends nothing and counts as answered: the
// message is not drafted for again. A notice that notify_owner did not take is kept and put again
// on later passes, with no new draft, since the reply before it already moved the thread on.
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
// Reading is not handling. The owner reading a thread in the portal marks it read, and the agent
// still takes its turn on it: only the owner's own message (the thread's newest is then this side's)
// or an ask they answer means they took the matter over. So a pass visits a thread that is unread,
// and also one whose newest message (get_inbox's last_at) is newer than when the pass before saw it.
// A thread is first seen by the first pass after a start: one the owner read while the agent was
// stopped is left to them, as before. last_at is in seconds, so a second message of a thread in the
// same second as one a pass has seen, read by the owner before the next pass, is left to them too;
// a webhook (onMessage) reaches it either way.
//
// read_thread marks the thread read before the model has drafted anything. A turn that does not
// parse, or that the node refuses (an ask_owner surface outside its catalog), fails the attempt. A thread whose draft
// or send failed is therefore kept here and revisited by the next reconcile pass, up to
// MAX_ATTEMPTS times; a process that stops in between loses it, because the node no longer
// counts it unread. A request stays in list_pending until it is answered or expires, so each
// reconcile pass reaches an unanswered one again. Each retry's prompt carries the previous
// attempt's refusal, by code with this agent's line for it (refusals.ts), never the node's text;
// a retry after a reply put inside the notice must still answer the contact (REPLY_KEPT).
// The last failed attempt marks the span it runs in as failed, by its code; for a contact's
// message it also puts one notice for the owner, fixed text written here (GAVE_UP_SURFACE), so a
// turn given up still reaches them; a notice the node does not take is logged and not put again.

import { createHash } from 'node:crypto'
import { unmarked, type Fail, type Log } from './log.ts'
import {
  NodeRefusal,
  refusalCode,
  type InboxThread,
  type NodeClient,
  type PendingRequest,
  type SurfaceArgs,
  type ThreadMessage,
} from './node.ts'
import { Bounded } from './bounded.ts'
import { requestPrompt, threadPrompt } from './prompt.ts'
import { refusedOf, type Refused } from './refusals.ts'
import { Budget } from './budget.ts'
import type { Answer } from './config.ts'
import { Turns, type Turn, type TurnType } from './turn.ts'

/**
 * Writes the model's answer for a prompt: a turn, as JSON text. The model behind it has no tools.
 * It throws a NodeRefusal to refuse an answer by code (runtime.ts: draft:truncated).
 */
export type Draft = (prompt: string) => Promise<string>

/** The turns offered for a message with no ask, and for one whose ask is no longer open. */
export const FIRST_TURNS: readonly TurnType[] = ['reply', 'ask', 'notify', 'none']
export const AFTER_ASK_TURNS: readonly TurnType[] = ['reply', 'notify', 'none']

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

/**
 * The notice put for a contact's message whose turn was given up, so the owner learns it waits on
 * them: written here, never by the model, in the node's owner catalog (Column root, the TLDR Text).
 */
export const GAVE_UP_TLDR = 'Waiting on you: I could not prepare an answer to a message the contact sent here.'
export const GAVE_UP_SURFACE = [
  { version: 'v0.9.1', createSurface: { surfaceId: 'gave-up', catalogId: 'https://hdtp.dev/a2ui/v0_9_1/catalogs/owner/catalog.json' } },
  {
    version: 'v0.9.1',
    updateComponents: {
      surfaceId: 'gave-up',
      components: [
        { id: 'root', component: 'Column', children: ['tldr'] },
        { id: 'tldr', component: 'Text', text: GAVE_UP_TLDR },
      ],
    },
  },
] as const

/**
 * The refusals after which a thread's next attempt must still answer the contact (a reply, or a
 * notify with its reply): the reply was put inside the notice, or the attempt after that dropped it.
 */
export const REPLY_KEPT: readonly string[] = ['draft:reply_in_notice', 'draft:reply_dropped']

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

/** The node's rule, when a refusal names one (ask_owner's invalid_surface:<rule>), as a log field. */
const nodeReason = (e: unknown): Record<string, string> => (e instanceof NodeRefusal && e.reason !== '' ? { node_reason: e.reason } : {})

/** The budget's key for a contact of an account. */
const contactKey = (accountId: string, contactFpr: string) => `${accountId}\0${contactFpr}`

export class Responder {
  /** Keys of replies sent (msg_ids) and of requests answered. */
  private readonly done = new Bounded<true>(REMEMBERED)
  /** Attempts per key that has not succeeded. */
  private readonly attempts = new Bounded<number>(REMEMBERED)
  /** Threads (account \0 thread) to revisit on the next reconcile pass. */
  private readonly revisit = new Bounded<true>(REMEMBERED)
  /** Each thread's last_at as the last pass saw it: a thread that moved since is visited, read or not. */
  private readonly seen = new Bounded<number>(REMEMBERED)
  /** Threads with an open ask, visited by each reconcile pass until it is not. */
  private readonly waiting = new Bounded<true>(REMEMBERED)
  /** The last attempt's refusal per key that has not succeeded, told to the next attempt. */
  private readonly refused = new Bounded<Refused>(REMEMBERED)
  /** Notices a turn chose that notify_owner has not taken yet, by thread, with the reply key they follow. */
  private readonly owed = new Bounded<{ key: string; args: SurfaceArgs }>(REMEMBERED)
  /** The owner's display name by account, as the read of it (nameOf): passes that meet share one. */
  private readonly names = new Map<string, Promise<string>>()
  /** Work in flight by key, and whether another call asked for it while it ran. */
  private readonly running = new Map<string, { again: boolean }>()

  private readonly node: NodeClient
  private readonly draft: Draft
  private readonly log: Log
  private readonly turnCap: number
  private readonly answer: Answer
  private readonly firstStart: number
  private readonly budget: Budget
  private readonly turns: Turns
  private readonly fail: Fail

  /** `fail` marks the span a turn is given up in as failed (observe.ts). */
  constructor(node: NodeClient, draft: Draft, log: Log, rules: Rules, fail: Fail = unmarked) {
    this.node = node
    this.fail = fail
    this.turns = new Turns(node)
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
   * One pass over one account: the owner's name if it is not read yet, then its open requests, since a caller is waiting on each, then
   * its unread threads, those with a newer message than the last pass saw (read by the owner or
   * not), the threads a failure left to revisit, those with an open ask, and those owing a notice. A section that fails is logged
   * by code and the pass goes on, so a failing list_pending does not keep threads unanswered.
   */
  async reconcileAccount(accountId: string): Promise<void> {
    await this.nameOf(accountId)
    await this.section('list_pending', async () => {
      for (const row of await this.node.listPending(accountId)) {
        await this.answerRequest(accountId, row)
      }
    })
    await this.section('get_inbox', async () => {
      for (const row of await this.node.getInbox(accountId)) {
        const where = `${accountId}\0${row.thread_id}`
        const before = this.seen.get(where)
        this.seen.set(where, row.last_at)
        const moved = before !== undefined && row.last_at > before
        if (row.unread > 0 || moved || this.revisit.has(where) || this.waiting.has(where) || this.owed.has(where)) {
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
    const ids = { thread_id: row.thread_id }
    await this.single(where, async () => {
      // A notice already chosen is the owner's, whatever has happened to the contact since.
      await this.deliver(where, ids)
      if (row.contact_status !== 'active') {
        this.revisit.delete(where)
        this.waiting.delete(where)
        this.log.info('contact_not_active', { thread_id: row.thread_id, status: row.contact_status })
        return
      }
      if (row.last_at < this.firstStart) {
        this.revisit.delete(where)
        this.log.info('before_first_start', ids)
        return
      }
      const contact = contactKey(accountId, row.contact_fpr)
      if (this.answer === 'trusted') {
        const c = (await this.node.listContacts(accountId)).find((x) => x.fingerprint === row.contact_fpr)
        if (c?.trust_flag !== TRUSTED) {
          this.revisit.delete(where)
          this.waiting.delete(where)
          this.log.info('contact_not_trusted', ids)
          return
        }
      }
      if (!this.budget.room(contact)) {
        // Kept to revisit, if it was: a thread a failed draft left read is answered once the
        // hour moves on, as an unread one is.
        this.log.info('contact_budget', ids)
        return
      }
      const schema = await this.turns.schema()
      // The thread's asks and notices, newest first (the node's newest 100). An open ask holds the
      // thread; the rest go to the model below.
      const asks = await this.node.listAsks(accountId, row.thread_id)
      if (asks.some((a) => a.kind === 'ask' && a.status === 'open')) {
        this.revisit.delete(where)
        this.waiting.set(where, true)
        this.log.info('ask_open', ids)
        return
      }
      this.waiting.delete(where)
      const messages = await this.node.readThread(accountId, row.thread_id)
      const newest = messages.at(-1)
      if (!newest || newest.direction !== 'in') {
        this.revisit.delete(where)
        return
      }
      if (typeof newest.message_id !== 'string' || newest.message_id === '') {
        this.revisit.delete(where)
        this.log.warn('message_id_missing', ids)
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
      // The ask this message raised, now answered with no message to the contact, or expired. The
      // person's answers to the thread's earlier asks go to the model as their decisions, and the
      // thread's notices too, so an agreement already notified is not notified again; both oldest
      // first.
      const ask = asks.find((a) => a.kind === 'ask' && a.for_message_id === newest.message_id)
      const oldest = [...asks].reverse()
      const decisions = oldest.filter((a) => a !== ask && a.status === 'answered').map((a) => a.answer_text)
      const notices = oldest.filter((a) => a.kind === 'notice').map((a) => a.tldr)
      const allowed = ask ? AFTER_ASK_TURNS : FIRST_TURNS
      const owner = await this.nameOf(accountId)
      const surface = { account_id: accountId, thread_id: row.thread_id, for_message_id: newest.message_id }
      const work = async (refused?: Refused) => {
        const turn = await this.write(contact, threadPrompt(messages, schema, allowed, { ask, decisions, notices, owner, refused }), allowed, owner)
        // The attempt before put a reply where the schema has none: a misplaced field, which does
        // not change that the contact was to be answered.
        if (refused && REPLY_KEPT.includes(refused.refused) && turn.type !== 'reply' && !(turn.type === 'notify' && turn.reply !== undefined)) {
          throw new NodeRefusal('draft', 'reply_dropped')
        }
        const send = (text: string) =>
          this.node.sendToContact({ account_id: accountId, contact_fpr: row.contact_fpr, thread_id: row.thread_id, msg_id: key, text })
        switch (turn.type) {
          case 'reply':
            await send(turn.text)
            this.log.info('replied', { thread_id: row.thread_id, msg_id: key })
            return 'done'
          case 'ask':
            // The ids last: a surface schema that let them through would not move the ask elsewhere.
            await this.node.askOwner({ ...turn.ask, ...surface })
            this.waiting.set(where, true)
            this.log.info('asked', ids)
            return 'waiting'
          case 'notify':
            if (turn.reply !== undefined) {
              await send(turn.reply)
              this.log.info('replied', { thread_id: row.thread_id, msg_id: key })
            }
            this.owed.set(where, { key, args: { ...turn.notice, ...surface } })
            await this.deliver(where, ids)
            return 'done'
          case 'none':
            this.log.info('no_reply', ids)
            return 'done'
        }
      }
      await this.attempt(key, where, ids, work, () => this.tellGaveUp(surface, ids))
    })
  }

  /**
   * Tells the owner that a contact's message waits on them, its turn given up: one notice, fixed
   * text, put once; a notice the node does not take is logged by code, and not put again.
   */
  private async tellGaveUp(surface: SurfaceArgs, ids: Record<string, string>): Promise<void> {
    try {
      await this.node.notifyOwner({ surface: GAVE_UP_SURFACE, ...surface })
      this.log.info('gave_up_notified', ids)
    } catch (e) {
      this.log.warn('gave_up_notice_failed', { ...ids, reason: refusalCode(e), ...nodeReason(e) })
    }
  }

  /**
   * Puts the notice a thread owes, if it owes one, under attempts of its own. It is kept until
   * notify_owner takes it or its attempts run out.
   */
  private async deliver(where: string, ids: Record<string, string>): Promise<void> {
    const owed = this.owed.get(where)
    if (!owed) return
    const key = `notice\0${owed.key}`
    await this.attempt(key, null, ids, async () => {
      await this.node.notifyOwner(owed.args)
      this.log.info('notified', ids)
      return 'done'
    })
    if (this.done.has(key) || (this.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) this.owed.delete(where)
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
      const schema = await this.turns.schema()
      await this.attempt(key, null, { request_id: row.ID }, async (refused) => {
        const turn = (await this.write(contact, requestPrompt(row, schema, refused), ['reply'])) as Extract<Turn, { type: 'reply' }>
        await this.node.answerRequest({ account_id: accountId, request_id: row.ID, result: turn.text })
        this.log.info('answered', { request_id: row.ID })
        return 'done'
      })
    })
  }

  /**
   * The model's turn for a prompt, counted against the contact's budget; a failure, an empty answer
   * or one that is not an allowed turn is a refusal named draft. The budget was checked before the
   * work began, and is checked again here, where it is spent, for drafts of one contact that ran
   * side by side.
   */
  private async write(contact: string, prompt: string, allowed: readonly TurnType[], owner = ''): Promise<Turn> {
    if (!this.budget.take(contact)) throw new NodeRefusal('draft', 'contact_budget')
    let text: string
    try {
      text = (await this.draft(prompt)).trim()
    } catch (e) {
      // A refusal the draft names (draft:truncated) keeps its code; anything else is the model failing.
      if (e instanceof NodeRefusal) throw e
      throw new NodeRefusal('draft', 'model_failed')
    }
    if (!text) throw new NodeRefusal('draft', 'empty')
    return this.turns.read(text, allowed, owner)
  }

  /**
   * The owner's display name, read from their card (export_card) once per account: at the account's
   * first pass, or its first webhook. "" when the card names no one; a failed read is logged, the
   * turn goes on without the name, and the next turn reads it again. Passes that start before the
   * first read ends wait on that read rather than make their own.
   */
  private nameOf(accountId: string): Promise<string> {
    const known = this.names.get(accountId)
    if (known !== undefined) return known
    const read = this.node.ownerName(accountId).then(
      (name) => {
        this.log.info('owner_name', { account_id: accountId, named: name !== '' })
        return name
      },
      (e: unknown) => {
        this.names.delete(accountId)
        this.log.warn('owner_name_unread', { account_id: accountId, reason: refusalCode(e) })
        return ''
      },
    )
    this.names.set(accountId, read)
    return read
  }

  /**
   * Runs one attempt for a key, counting it, and keeps the thread to revisit while attempts remain.
   * Work that ends 'waiting' (an ask put) leaves the key unanswered, for the thread to be drafted
   * for again once the ask is no longer open. Work is handed the previous attempt's refusal, when it
   * had one this agent can explain (refusals.ts). The last failed attempt marks the span it runs in
   * as failed, by its code, and then runs `gaveUp`.
   */
  private async attempt(
    key: string,
    where: string | null,
    ids: Record<string, string>,
    work: (refused?: Refused) => Promise<'done' | 'waiting'>,
    gaveUp?: () => Promise<void>,
  ): Promise<void> {
    const n = (this.attempts.get(key) ?? 0) + 1
    if (n > MAX_ATTEMPTS) {
      if (where) this.revisit.delete(where)
      return
    }
    this.attempts.set(key, n)
    try {
      if ((await work(this.refused.get(key))) === 'done') this.done.set(key, true)
      this.attempts.delete(key)
      this.refused.delete(key)
      if (where) this.revisit.delete(where)
    } catch (e) {
      const last = n >= MAX_ATTEMPTS
      this.log.warn(last ? 'gave_up' : 'attempt_failed', { ...ids, reason: refusalCode(e), ...nodeReason(e), attempt: n })
      const refused = last ? null : refusedOf(e)
      if (refused) this.refused.set(key, refused)
      else this.refused.delete(key)
      if (where) {
        if (last) this.revisit.delete(where)
        else this.revisit.set(where, true)
      }
      if (last) {
        this.fail(refusalCode(e))
        await gaveUp?.()
      }
    }
  }
}
