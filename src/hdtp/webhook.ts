// POST /hdtp/webhook: the node's delivery, verified, acknowledged, then handled.
//
// The order is fixed. The body is read up to MAX_BODY_BYTES, counting the bytes read; the
// signature is checked over those raw bytes before anything parses them; the envelope's own
// `type` (signed) decides what happens, never the unsigned X-HDTP-Event-Type header. The answer
// is sent before the work starts: the node's sender, as planned (not built yet), makes one attempt
// with a 10 s timeout, and a model call can take longer than that.
//
// Anyone who can reach the route can post to it, and what Studio shows is held in memory for 24
// hours. So a hit gets a span, and lines of its own, only once its delivery is verified and new: a
// delivery only the node can sign. Every other hit (refused before or at the signature, a signed
// body that is not an envelope, a delivery posted again) is counted by its answer's code, and the
// counts are logged as one line, at most once every UNTRACED_EVERY_MS.

import { Bounded } from './bounded.ts'
import { untraced, type Fields, type Log, type Trace } from './log.ts'
import { refusalCode } from './node.ts'
import { SIGNATURE_HEADER, verifySignature } from './signature.ts'

/** The largest body read. An envelope carries ids, never content. */
export const MAX_BODY_BYTES = 64 * 1024
/** How many event ids are remembered, so a delivery posted twice is handled once. */
export const SEEN_EVENTS = 10_000
/** How often the counts of the hits not traced one by one are logged, when there are any. */
export const UNTRACED_EVERY_MS = 60 * 1000

/** The hits answered with no span and no line of their own, counted by their answer's code. */
export class Tally {
  private readonly counts = new Map<string, number>()
  count(code: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1)
  }
  /** Logs every count as one line, webhook_untraced, when there is one, and starts again from none. */
  flush(log: Log): void {
    if (this.counts.size === 0) return
    const fields: Fields = Object.fromEntries(this.counts)
    this.counts.clear()
    log.warn('webhook_untraced', fields)
  }
}

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
  /** The span each hit runs in, from the request to the end of the task it scheduled. */
  trace?: Trace
  /** Unix seconds. */
  now?: () => number
  /** Runs a task after the answer is sent. */
  schedule?: (task: () => Promise<void>) => void
  /** Where the hits that get no span are counted; the caller logs it every UNTRACED_EVERY_MS. */
  tally?: Tally
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
  const trace = opts.trace ?? untraced
  const schedule = opts.schedule ?? ((task) => void setImmediate(() => void task()))
  const seen = new Bounded<true>(SEEN_EVENTS)
  const tally = opts.tally ?? new Tally()

  /** The verified, new envelope, or the answer to a hit that gets no span, counted by its code. */
  const verify = async (req: Request): Promise<Envelope | Response> => {
    const refuse = (status: number, code: string, body: Record<string, string> = { code }) => {
      tally.count(code)
      return answer(status, body)
    }
    const secret = opts.secret()
    if (!secret) return refuse(503, 'webhook_secret_unset')
    // A body the sender stops sending part-way is not a delivery of the node's either.
    const body = await readBounded(req, MAX_BODY_BYTES).catch(() => undefined)
    if (body === undefined) return refuse(400, 'unreadable')
    if (body === null) return refuse(413, 'too_large')
    if (!verifySignature(secret, body, req.headers.get(SIGNATURE_HEADER), now())) return refuse(401, 'bad_signature')
    const env = parseEnvelope(body)
    if (!env) return refuse(400, 'bad_envelope')
    if (seen.has(env.id)) return refuse(200, 'duplicate', { status: 'duplicate' })
    seen.set(env.id, true)
    return env
  }

  /** The answer to a verified, new delivery, and the task to run after it is sent. */
  const handle = (env: Envelope): [Response, (() => Promise<void>) | null] => {
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
      return [answer(200, { status: 'ignored' }), null]
    }
    opts.log.info('webhook_accepted', { event_id: env.id, type: env.type })
    return [answer(202, { status: 'accepted' }), task]
  }

  return async (req) => {
    const env = await verify(req)
    if (env instanceof Response) return env
    return new Promise<Response>((answered, failed) => {
      trace('webhook', async () => {
        const [response, task] = handle(env)
        answered(response)
        if (!task) return
        // The span stays open until the task, and its failure's line, are done.
        await new Promise<void>((done) =>
          schedule(() =>
            task()
              .catch((e: unknown) => opts.log.warn('webhook_task_failed', { reason: refusalCode(e) }))
              .finally(done),
          ),
        )
      }).catch(failed)
    })
  }
}
