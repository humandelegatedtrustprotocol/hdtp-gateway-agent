// Test doubles: a signer written from the node's grammar, and an owner MCP that answers as the
// node's does (internal/internalui/ownermcp/server.go), held in memory.

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Log } from '../src/hdtp/log.ts'
import { NodeRefusal, type Catalog, type JsonSchema, type OwnerAsk, type PendingRequest, type ThreadMessage, type ToolListing } from '../src/hdtp/node.ts'
import type { Rules } from '../src/hdtp/responder.ts'
import { DEFAULT_AGENT_TURN_CAP, DEFAULT_REPLIES_PER_HOUR } from '../src/hdtp/config.ts'

/** `t=<t>,v1=<hmac>[,v1=<hmac>]` over `<t>.<body>`, written from the grammar, not from the verifier. */
export function sign(secrets: string[], body: string, t: number): string {
  const v1 = secrets.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`)
  return `t=${t},${v1.join(',')}`
}

export function envelope(id: string, type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ id, type, created_at: 1_760_000_000_000, identity: 'alex', data })
}

/**
 * The responder's rules at their defaults, on the host's clock, with any of them replaced, but for
 * two a test of its own sets: every contact is answered (a FakeNode's contacts are messages_only,
 * as the node's are by default), and the first start is 0, before every message a FakeNode holds.
 */
export function rules(over: Partial<Rules> = {}): Rules {
  return {
    answer: 'all',
    turnCap: DEFAULT_AGENT_TURN_CAP,
    repliesPerHour: DEFAULT_REPLIES_PER_HOUR,
    firstStart: 0,
    now: () => Math.floor(Date.now() / 1000),
    ...over,
  }
}

/** The node's tools/list for the tools this agent calls (test/wire.ts says where each was captured). */
export const TOOLS = JSON.parse(readFileSync(new URL('./owner-mcp-tools.json', import.meta.url), 'utf8')) as Array<{
  name: string
  inputSchema: JsonSchema
}>

/** The model's answers, as the turn schema has them. */
export const reply = (text: string) => JSON.stringify({ type: 'reply', text })
export const none = () => JSON.stringify({ type: 'none' })
/** The owner catalog ask_owner and notify_owner name (test/owner-mcp-tools.json). */
export const CATALOG_ID = 'https://hdtp.dev/a2ui/v0.9.1/owner-catalog.json'
/**
 * An A2UI surface in the node's owner catalog: a TLDR, the terms, and for an ask the ready replies
 * and a field to write one's own, last.
 */
export function surface(tldr: string, terms: Record<string, string>, choices: string[] = []): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [
    { id: 'tldr', component: 'Text', text: tldr },
    { id: 'terms', component: 'KeyValue', rows: Object.entries(terms).map(([label, value]) => ({ label, value })) },
  ]
  if (choices.length) {
    parts.push({ id: 'pick', component: 'Choice', options: choices.map((label) => ({ label })) })
    parts.push({ id: 'own', component: 'TextField', label: 'Write my own' })
  }
  const components = [{ id: 'root', component: 'Column', children: parts.map((c) => c.id) }, ...parts]
  return [
    { version: 'v0.9.1', createSurface: { surfaceId: 's1', catalogId: CATALOG_ID } },
    { version: 'v0.9.1', updateComponents: { surfaceId: 's1', components } },
  ]
}
export const ask = (tldr: string, terms: Record<string, string>, choices: string[]) =>
  JSON.stringify({ type: 'ask', ask: { surface: surface(tldr, terms, choices) } })
export const notify = (tldr: string, terms: Record<string, string>, text?: string) =>
  JSON.stringify({ type: 'notify', notice: { surface: surface(tldr, terms) }, ...(text === undefined ? {} : { reply: text }) })

export function memoryLog(): Log & { lines: Array<{ code: string; fields?: Record<string, unknown> }> } {
  const lines: Array<{ code: string; fields?: Record<string, unknown> }> = []
  return {
    lines,
    info: (code, fields) => void lines.push({ code, fields }),
    warn: (code, fields) => void lines.push({ code, fields }),
  }
}

interface Thread {
  account: string
  contact_fpr: string
  contact_status: string
  messages: ThreadMessage[]
  readThrough: number
}

export interface ToolAnswer {
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

export const ok = (v: unknown): ToolAnswer => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
const refusal = (code: string, extra: Record<string, unknown> = {}): ToolAnswer => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ code, detail: 'refused', ...extra }) }],
})

/** The owner MCP's tools as the node answers them, over an in-memory store. */
export class FakeNode {
  accounts = ['acct-1']
  threads = new Map<string, Thread>()
  pending: PendingRequest[] = []
  /** Every tool called, in order, and the clock (Date.now()) at each call. */
  calls: string[] = []
  at: number[] = []
  /** Each wait_for_updates call, in order: its account and its `since`, undefined where omitted. */
  waits: Array<{ account: string; since: number | undefined }> = []
  /** How long wait_for_updates holds a call when nothing moves: the node's 25 s. */
  holdMs = 25_000
  /** Set to make the next wait_for_updates answer that its cursor expired. */
  expireNext = false
  /** Set to make every wait_for_updates answer this, at once, in place of the node's answer. */
  waitAnswer: ToolAnswer | undefined
  /** Messages recorded outbound, one per msg_id, as the node records them. */
  sent: Array<{ account_id: string; contact_fpr: string; thread_id: string; msg_id: string; text: string }> = []
  answered: Array<{ request_id: string; result: string }> = []
  /** Set to make send_to_contact record the message and answer it undelivered. */
  undelivered = false
  /** Each contact's trust flag, by fingerprint; one not set is messages_only, the node's default. */
  trust = new Map<string, string>()
  /** Tools that answer the refusal `internal`. */
  failing = new Set<string>()
  /** The asks put with ask_owner, and the notices put with notify_owner, as the node holds them. */
  asks: Array<OwnerAsk & { account: string; contact: string; surface: unknown }> = []
  notices: Array<{ account: string; thread_id: string; for_message_id: string; surface: unknown }> = []
  /** How many of the next ask_owner calls answer `bad_request`, as the node does for a surface its catalog refuses. */
  invalidSurfaces = 0
  /** Tools tools/list does not offer, as an older node would not. */
  unlisted = new Set<string>()
  private clock = 1_760_000_000
  /** The change log wait_for_updates reads, as the node's: ids in order, a kind, a thread. */
  private changes: Array<{ id: number; account: string; thread_id?: string; pending?: boolean }> = []
  private woken: Array<() => void> = []

  private change(account: string, c: { thread_id?: string; pending?: boolean }): void {
    this.changes.push({ id: this.changes.length + 1, account, ...c })
    for (const wake of this.woken.splice(0)) wake()
  }

  /** An agent-answered call waiting for an answer, as the node records one (an EventPending change). */
  request(id: string, account = 'acct-1'): void {
    this.pending.push({ ID: id, ContactFpr: 'fpr-contact', Capability: 'ask_alex', Args: '{}', TrustFlag: this.trustOf('fpr-contact'), Status: 'open', ExpiresAt: 0 })
    this.change(account, { pending: true })
  }

  /** What moved for an account after `since`: the wait's answer, or null when nothing did. */
  private movedSince(account: string, since: number) {
    const newest = this.changes.length
    const rows = this.changes.filter((c) => c.account === account && c.id > since)
    if (rows.length === 0) return null
    const threads = [...new Set(rows.flatMap((c) => (c.thread_id ? [c.thread_id] : [])))].map((thread_id) => ({ thread_id }))
    return { cursor: newest, threads: threads.length ? threads : null, timed_out: false }
  }

  /** wait_for_updates as watch.go answers it, holding for holdMs when nothing moved. */
  private async wait(account: string, since: number | undefined): Promise<ToolAnswer> {
    const counts = () => ({
      contact_requests: 0,
      pending_addresses: 0,
      pending_requests: this.pending.filter((p) => p.Status === 'open').length,
    })
    if (since === undefined) return ok({ cursor: this.changes.length, threads: null, ...counts(), timed_out: false })
    if (this.expireNext || since > this.changes.length) {
      this.expireNext = false
      return ok({ cursor: this.changes.length, cursor_expired: true, threads: null, ...counts(), timed_out: false })
    }
    const end = Date.now() + this.holdMs
    for (;;) {
      const moved = this.movedSince(account, since)
      if (moved) return ok({ ...moved, ...counts() })
      const left = end - Date.now()
      if (left <= 0) return ok({ cursor: this.changes.length, threads: null, ...counts(), timed_out: true })
      await new Promise<void>((r) => {
        const t = setTimeout(r, left)
        t.unref?.()
        this.woken.push(() => {
          clearTimeout(t)
          r()
        })
      })
    }
  }

  /** A new message's id and time, as the node gives them: the msg_id, and the clock's next second. */
  private stamp(): { message_id: string; created_at: number } {
    const at = ++this.clock
    return { message_id: `msg-${at}`, created_at: at }
  }

  /** A tool's input schema, as the node's tools/list gives it. */
  toolSchema = async (name: string): Promise<JsonSchema> => {
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool || this.unlisted.has(name)) throw new NodeRefusal(name, 'tool_not_offered')
    return structuredClone(tool.inputSchema)
  }

  /** The node's tools/list as the client takes it: every tool but those unlisted, none skipped. */
  listTools = async (): Promise<ToolListing> => ({
    offered: TOOLS.map((t) => t.name).filter((n) => !this.unlisted.has(n)),
    skipped: {},
  })

  catalog: Catalog = { toolSchema: (name) => this.toolSchema(name), listTools: () => this.listTools() }

  /**
   * The owner answers an ask in the portal: a ready reply or their own words are sent to the
   * contact as the owner's message, labelled human; `send: false` answers it with no message.
   */
  answerAsk(id: string, text: string, send = true): void {
    const a = this.asks.find((x) => x.id === id)
    if (!a || a.status !== 'open') throw new Error('no open ask')
    a.status = 'answered'
    a.answer_text = text
    if (send) this.outbound(a.thread_id, text, 'human')
    else this.change(a.account, { thread_id: a.thread_id })
  }

  /** An ask's 24 hours run out. */
  expireAsk(id: string): void {
    const a = this.asks.find((x) => x.id === id)
    if (!a || a.status !== 'open') throw new Error('no open ask')
    a.status = 'expired'
    this.change(a.account, { thread_id: a.thread_id })
  }

  trustOf(fpr: string): string {
    return this.trust.get(fpr) ?? 'messages_only'
  }

  thread(id: string, contact = 'fpr-contact', status = 'active', account = 'acct-1'): void {
    this.threads.set(id, { account, contact_fpr: contact, contact_status: status, messages: [], readThrough: 0 })
  }

  /** A message from the contact, labelled as their side labelled it ('human' or 'agent'). */
  inbound(threadId: string, body: string, sender = 'human'): void {
    const th = this.threads.get(threadId)
    if (!th) throw new Error('no thread')
    th.messages.push({ direction: 'in', sender, kind: 'text', body, trust: 'messages_only', ...this.stamp() })
    this.change(th.account, { thread_id: threadId })
  }

  /** A message from this side: the owner in the portal ('human') or an agent ('agent'). */
  outbound(threadId: string, body: string, sender = 'human'): void {
    const th = this.threads.get(threadId)
    if (!th) throw new Error('no thread')
    th.messages.push({ direction: 'out', sender, kind: 'text', body, trust: 'messages_only', ...this.stamp() })
    th.readThrough = th.messages.length
    this.change(th.account, { thread_id: threadId })
  }

  /** One tool call, answered as the node answers it. */
  call = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    this.calls.push(name)
    this.at.push(Date.now())
    if (this.failing.has(name)) return refusal('internal')
    const acct = args.account_id as string
    if (name !== 'list_accounts' && !this.accounts.includes(acct)) return { isError: true, content: [{ type: 'text', text: '{"code":"permission_denied"}' }] }
    switch (name) {
      case 'list_accounts':
        return ok(this.accounts)
      case 'get_inbox':
        return ok(
          [...this.threads.entries()]
            .filter(([, t]) => t.account === acct)
            .map(([id, t]) => ({
              thread_id: id,
              contact_fpr: t.contact_fpr,
              unread: t.messages.slice(t.readThrough).filter((m) => m.direction === 'in').length,
              last_at: t.messages.at(-1)?.created_at ?? 0,
              contact_status: t.contact_status,
              removed_contact: null,
            })),
        )
      case 'list_contacts': {
        // One row per contact a thread names, in the fields of the node's contactView this fake holds.
        const rows = new Map<string, { fingerprint: string; status: string; trust_flag: string }>()
        for (const t of this.threads.values()) {
          if (t.account !== acct || t.contact_status === 'removed') continue
          rows.set(t.contact_fpr, { fingerprint: t.contact_fpr, status: t.contact_status, trust_flag: this.trustOf(t.contact_fpr) })
        }
        return ok([...rows.values()])
      }
      case 'read_thread': {
        const th = this.threads.get(args.thread_id as string)
        if (!th || th.account !== acct) return refusal('not_found')
        th.readThrough = th.messages.length
        return ok(th.messages)
      }
      case 'send_to_contact': {
        const th = this.threads.get(args.thread_id as string)
        if (!th) return refusal('not_found')
        // The node's idempotency: one row per (account, contact, out, msg_id); a repeat writes nothing.
        const dup = this.sent.some((s) => s.account_id === acct && s.contact_fpr === args.contact_fpr && s.msg_id === args.msg_id)
        if (!dup) {
          this.sent.push(args as (typeof this.sent)[number])
          th.messages.push({ direction: 'out', sender: 'agent', kind: 'text', body: args.text as string, trust: 'messages_only', ...this.stamp() })
          th.readThrough = th.messages.length
          this.change(acct, { thread_id: args.thread_id as string })
        }
        if (this.undelivered) return refusal('unavailable', { ThreadID: args.thread_id, Status: 'pending' })
        return ok({ ThreadID: args.thread_id, Status: 'pending' })
      }
      case 'list_pending':
        return ok(this.pending.filter((p) => p.Status === 'open'))
      case 'answer_request': {
        const row = this.pending.find((p) => p.ID === args.request_id)
        if (!row) return refusal('not_found')
        if (row.Status !== 'open') return refusal('conflict')
        row.Status = 'answered'
        this.answered.push({ request_id: args.request_id as string, result: args.result as string })
        return ok({ relayed: true })
      }
      case 'ask_owner': {
        const th = this.threads.get(args.thread_id as string)
        if (!th || th.account !== acct) return refusal('not_found')
        // Idempotent on for_message_id: the ask already put for that message answers, whatever its status.
        const same = this.asks.find((a) => a.account === acct && a.thread_id === args.thread_id && a.for_message_id === args.for_message_id)
        if (same) return ok({ id: same.id, status: same.status })
        if (this.asks.some((a) => a.account === acct && a.thread_id === args.thread_id && a.status === 'open')) return refusal('conflict')
        if (this.invalidSurfaces > 0) {
          this.invalidSurfaces--
          return refusal('bad_request')
        }
        const id = `ask-${this.asks.length + 1}`
        this.asks.push({
          id,
          kind: 'ask',
          account: acct,
          contact: th.contact_fpr,
          thread_id: args.thread_id as string,
          for_message_id: args.for_message_id as string,
          status: 'open',
          answer_text: '',
          surface: args.surface,
        })
        this.change(acct, { thread_id: args.thread_id as string })
        return ok({ id, status: 'open' })
      }
      case 'notify_owner': {
        const th = this.threads.get(args.thread_id as string)
        if (!th || th.account !== acct) return refusal('not_found')
        const same = this.notices.some((n) => n.account === acct && n.thread_id === args.thread_id && n.for_message_id === args.for_message_id)
        if (!same) {
          this.notices.push({ account: acct, thread_id: args.thread_id as string, for_message_id: args.for_message_id as string, surface: args.surface })
        }
        return ok({ status: 'posted' })
      }
      case 'list_asks': {
        // As the node filters them: status open for the open asks, newest first; contact_fpr for one
        // contact's asks and notices; neither for all. The fake lists its asks before its notices,
        // not by time; the responder finds a row by its ids, never by its place.
        if (args.status !== undefined && args.status !== 'open') return refusal('bad_request')
        const rows = [
          ...this.asks.map(({ account, contact, surface: _s, ...row }) => ({ account, contact, ...row })),
          ...this.notices.map((n) => ({
            account: n.account,
            contact: this.threads.get(n.thread_id)!.contact_fpr,
            id: `notice-${n.thread_id}-${n.for_message_id}`,
            kind: 'notice',
            thread_id: n.thread_id,
            for_message_id: n.for_message_id,
            status: 'posted',
            answer_text: '',
          })),
        ].filter((r) => r.account === acct)
        const listed =
          args.contact_fpr !== undefined
            ? rows.filter((r) => r.contact === args.contact_fpr)
            : rows.filter((r) => args.status === undefined || (r.kind === 'ask' && r.status === 'open')).reverse()
        return ok({ asks: listed.map(({ account: _a, ...row }) => row) })
      }
      case 'wait_for_updates':
        this.waits.push({ account: acct, since: args.since as number | undefined })
        return this.waitAnswer ?? this.wait(acct, args.since as number | undefined)
      default:
        return refusal('not_found')
    }
  }
}
