// Test doubles: a signer written from the node's grammar, and an owner MCP that answers as the
// node's does (internal/internalui/ownermcp/server.go), held in memory.

import { createHmac } from 'node:crypto'
import type { Log } from '../src/hdtp/log.ts'
import type { PendingRequest, ThreadMessage } from '../src/hdtp/node.ts'

/** `t=<t>,v1=<hmac>[,v1=<hmac>]` over `<t>.<body>`, written from the grammar, not from the verifier. */
export function sign(secrets: string[], body: string, t: number): string {
  const v1 = secrets.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`)
  return `t=${t},${v1.join(',')}`
}

export function envelope(id: string, type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ id, type, created_at: 1_760_000_000_000, identity: 'alex', data })
}

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

interface ToolAnswer {
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

const ok = (v: unknown): ToolAnswer => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
const refusal = (code: string, extra: Record<string, unknown> = {}): ToolAnswer => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ code, detail: 'refused', ...extra }) }],
})

/** The owner MCP's tools as the node answers them, over an in-memory store. */
export class FakeNode {
  accounts = ['acct-1']
  threads = new Map<string, Thread>()
  pending: PendingRequest[] = []
  /** Every tool called, in order. */
  calls: string[] = []
  /** Messages recorded outbound, one per msg_id, as the node records them. */
  sent: Array<{ account_id: string; contact_fpr: string; thread_id: string; msg_id: string; text: string }> = []
  answered: Array<{ request_id: string; result: string }> = []
  /** Set to make send_to_contact record the message and answer it undelivered. */
  undelivered = false
  private clock = 1_760_000_000

  thread(id: string, contact = 'fpr-contact', status = 'active', account = 'acct-1'): void {
    this.threads.set(id, { account, contact_fpr: contact, contact_status: status, messages: [], readThrough: 0 })
  }

  inbound(threadId: string, body: string): void {
    const th = this.threads.get(threadId)
    if (!th) throw new Error('no thread')
    th.messages.push({ direction: 'in', sender: 'human', kind: 'text', body, trust: 'messages_only', created_at: ++this.clock })
  }

  outbound(threadId: string, body: string): void {
    const th = this.threads.get(threadId)
    if (!th) throw new Error('no thread')
    th.messages.push({ direction: 'out', sender: 'human', kind: 'text', body, trust: 'messages_only', created_at: ++this.clock })
    th.readThrough = th.messages.length
  }

  /** One tool call, answered as the node answers it. */
  call = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    this.calls.push(name)
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
          th.messages.push({ direction: 'out', sender: 'agent', kind: 'text', body: args.text as string, trust: 'messages_only', created_at: ++this.clock })
          th.readThrough = th.messages.length
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
      default:
        return refusal('not_found')
    }
  }
}
