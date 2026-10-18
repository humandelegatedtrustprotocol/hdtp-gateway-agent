// POST /hdtp/webhook: the node's delivery, verified, acknowledged, then handled.
//
// The order is fixed. The body is read up to MAX_BODY_BYTES, counting the bytes read; the
// signature is checked over those raw bytes before anything parses them; the envelope's own
// `type` (signed) decides what happens, never the unsigned X-HDTP-Event-Type header. The answer
// is sent before the work starts: the node makes one attempt with a 10 s timeout, and a model
// call can take longer than that.

import { Bounded } from './bounded.ts'
import type { Log } from './log.ts'
import { refusalCode } from './node.ts'
import { SIGNATURE_HEADER, verifySignature } from './signature.ts'

/** The largest body read. An envelope carries ids, never content. */
export const MAX_BODY_BYTES = 64 * 1024
/** How many event ids are remembered, so a delivery posted twice is handled once. */
export const SEEN_EVENTS = 10_000

export interface Envelope {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface Handlers {
  /** message.received naming a thread. */
  message(threadId: string): Promise<void>
  /** message.received without a thread id: walk the inbox instead. */
  reconcile(): Promise<void>
  /** request.pending naming a request. */
  request(requestId: string): Promise<void>
}

export interface ReceiverOptions {
  /** The endpoint's signing secret; undefined while it is not configured. */
  secret: () => string | undefined
  handlers: Handlers
  log: Log
  /** Unix seconds. */
  now?: () => number
  /** Runs a task after the answer is sent. */
  schedule?: (task: () => Promise<void>) => void
}

/** The body, or null when it is longer than `limit` bytes. Reads no further than the limit. */
export async function readBounded(req: Request, limit: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** The envelope in a verified body, or null when it is not one. */
export function parseEnvelope(body: Uint8Array): Envelope | null {
  let v: unknown
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const e = v as { id?: unknown; type?: unknown; data?: unknown }
  if (typeof e.id !== 'string' || e.id === '' || typeof e.type !== 'string' || e.type === '') return null
  const data = typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>) : {}
  return { id: e.id, type: e.type, data }
}

const answer = (status: number, body: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const idIn = (data: Record<string, unknown>, name: string) => {
  const v = data[name]
  return typeof v === 'string' && v !== '' ? v : null
}

/** The handler for POST /hdtp/webhook. */
export function createReceiver(opts: ReceiverOptions): (req: Request) => Promise<Response> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const schedule =
    opts.schedule ??
    ((task) => {
      setImmediate(() => {
        task().catch((e: unknown) => opts.log.warn('webhook_task_failed', { reason: refusalCode(e) }))
      })
    })
  const seen = new Bounded<true>(SEEN_EVENTS)

  return async (req) => {
    const secret = opts.secret()
    if (!secret) {
      opts.log.warn('webhook_secret_unset')
      return answer(503, { code: 'webhook_secret_unset' })
    }
    const body = await readBounded(req, MAX_BODY_BYTES)
    if (body === null) return answer(413, { code: 'too_large' })
    if (!verifySignature(secret, body, req.headers.get(SIGNATURE_HEADER), now())) {
      opts.log.warn('webhook_bad_signature')
      return answer(401, { code: 'bad_signature' })
    }
    const env = parseEnvelope(body)
    if (!env) return answer(400, { code: 'bad_envelope' })
    if (seen.has(env.id)) return answer(200, { status: 'duplicate' })
    seen.set(env.id, true)

    const h = opts.handlers
    let task: (() => Promise<void>) | null = null
    if (env.type === 'message.received') {
      const thread = idIn(env.data, 'thread_id')
      task = thread ? () => h.message(thread) : () => h.reconcile()
    } else if (env.type === 'request.pending') {
      const request = idIn(env.data, 'request_id')
      if (request) task = () => h.request(request)
      else opts.log.warn('webhook_request_without_id', { event_id: env.id })
    }
    if (!task) {
      opts.log.info('webhook_ignored', { event_id: env.id, type: env.type })
      return answer(200, { status: 'ignored' })
    }
    opts.log.info('webhook_accepted', { event_id: env.id, type: env.type })
    schedule(task)
    return answer(202, { status: 'accepted' })
  }
}
