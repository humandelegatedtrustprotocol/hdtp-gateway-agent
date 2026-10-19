import { describe, expect, it } from 'vitest'
import { nodeClientOver } from '../src/hdtp/node.ts'
import { Responder } from '../src/hdtp/responder.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { MAX_BODY_BYTES, createReceiver, type Handlers } from '../src/hdtp/webhook.ts'
import { FakeNode, envelope, memoryLog, reply, rules, sign } from './fakes.ts'

const secret = 'whsec_current'
const now = 1_760_000_000

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://agent/hdtp/webhook', { method: 'POST', body, headers })
}
const signed = (body: string, extra: Record<string, string> = {}) =>
  post(body, { [SIGNATURE_HEADER]: sign([secret], body, now), ...extra })

/** A receiver over a recording set of handlers, with the scheduled tasks kept to be awaited. */
function setup(opts: { secret?: string | undefined } = {}) {
  const seen: string[] = []
  const tasks: Array<Promise<void>> = []
  const handlers: Handlers = {
    message: async (t) => void seen.push(`message:${t}`),
    reconcile: async () => void seen.push('reconcile'),
    request: async (r) => void seen.push(`request:${r}`),
  }
  const receive = createReceiver({
    secret: () => ('secret' in opts ? opts.secret : secret),
    handlers,
    log: memoryLog(),
    now: () => now,
    schedule: (task) => void tasks.push(task()),
  })
  return { receive, seen, settle: () => Promise.all(tasks) }
}

describe('POST /hdtp/webhook', () => {
  it('refuses a forged body before any call to the node', async () => {
    const node = new FakeNode()
    node.thread('th1')
    node.inbound('th1', 'hello')
    let drafted = 0
    const responder = new Responder(nodeClientOver(node.call, node.catalog), async () => (drafted++, reply('hi')), memoryLog(), rules())
    const tasks: Array<Promise<void>> = []
    const receive = createReceiver({
      secret: () => secret,
      log: memoryLog(),
      now: () => now,
      schedule: (task) => void tasks.push(task()),
      handlers: {
        message: (t) => responder.onMessage(t),
        reconcile: () => responder.reconcile(),
        request: (r) => responder.onRequest(r),
      },
    })
    const body = envelope('evt_1', 'message.received', { thread_id: 'th1' })
    const header = sign([secret], body, now)
    const forged = body.replace('evt_1', 'evt_2')
    const res = await receive(post(forged, { [SIGNATURE_HEADER]: header }))
    await Promise.all(tasks)
    expect(res.status).toBe(401)
    expect(node.calls).toEqual([])
    expect(drafted).toBe(0)

    // The control: the same delivery, unaltered, gets through and is answered.
    const good = await receive(post(body, { [SIGNATURE_HEADER]: header }))
    await Promise.all(tasks)
    expect(good.status).toBe(202)
    expect(node.sent).toHaveLength(1)
  })

  it('refuses a delivery with no signature', async () => {
    const { receive, seen, settle } = setup()
    const res = await receive(post(envelope('evt_1', 'message.received', { thread_id: 'th1' })))
    await settle()
    expect(res.status).toBe(401)
    expect(seen).toEqual([])
  })

  it('refuses everything while no secret is configured', async () => {
    const { receive, seen } = setup({ secret: undefined })
    const res = await receive(signed(envelope('evt_1', 'message.received', { thread_id: 'th1' })))
    expect(res.status).toBe(503)
    expect(seen).toEqual([])
  })

  it('refuses a body over the limit by the bytes it read', async () => {
    const { receive, seen } = setup()
    // Multibyte: under the limit in UTF-16 units, over it in bytes.
    const pad = 'é'.repeat(MAX_BODY_BYTES / 2 + 1)
    const body = envelope('evt_1', 'message.received', { thread_id: 'th1', pad })
    expect(body.length).toBeLessThan(MAX_BODY_BYTES)
    const res = await receive(signed(body))
    expect(res.status).toBe(413)
    expect(seen).toEqual([])
  })

  it('refuses a signed body that is not an envelope', async () => {
    const { receive, seen } = setup()
    for (const body of ['not json', '[]', '{"type":"message.received"}', '{"id":"evt_1"}']) {
      const res = await receive(signed(body))
      expect(res.status, body).toBe(400)
    }
    expect(seen).toEqual([])
  })

  it('acknowledges an event it does not handle and does nothing with it', async () => {
    const { receive, seen, settle } = setup()
    const res = await receive(signed(envelope('evt_1', 'contact.requested', { fingerprint: 'f' })))
    await settle()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(seen).toEqual([])
  })

  it('goes by the signed type, never the unsigned header', async () => {
    const { receive, seen, settle } = setup()
    for (const [i, header] of ['message.received', 'request.pending'].entries()) {
      const body = envelope(`evt_${i}`, 'contact.requested', { request_id: 'r1', thread_id: 'th1' })
      const res = await receive(signed(body, { 'X-HDTP-Event-Type': header }))
      expect(res.status, header).toBe(200)
    }
    await settle()
    expect(seen).toEqual([])
  })

  it('answers 2xx and then handles message.received and request.pending', async () => {
    const { receive, seen, settle } = setup()
    const a = await receive(signed(envelope('evt_1', 'message.received', { thread_id: 'th1', message_id: 'm1' })))
    const b = await receive(signed(envelope('evt_2', 'request.pending', { request_id: 'req1' })))
    const c = await receive(signed(envelope('evt_3', 'message.received', {})))
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202])
    await settle()
    expect(seen).toEqual(['message:th1', 'request:req1', 'reconcile'])
  })

  it('does not count an unsigned delivery as seen: the signed one with its id is still handled', async () => {
    const { receive, seen, settle } = setup()
    const body = envelope('evt_1', 'message.received', { thread_id: 'th1' })
    const unsigned = await receive(post(body))
    const good = await receive(signed(body))
    await settle()
    expect([unsigned.status, good.status]).toEqual([401, 202])
    expect(seen).toEqual(['message:th1'])
  })

  it('handles a delivery posted twice once', async () => {
    const { receive, seen, settle } = setup()
    const body = envelope('evt_1', 'message.received', { thread_id: 'th1' })
    const first = await receive(signed(body))
    const second = await receive(signed(body))
    await settle()
    expect([first.status, second.status]).toEqual([202, 200])
    expect(seen).toEqual(['message:th1'])
  })
})
