// The real client path: @mastra/mcp's MCPClient against an owner MCP served over HTTP as the node
// serves it (test/wire.ts).

import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeRefusal, connectNode } from '../src/hdtp/node.ts'
import { Responder } from '../src/hdtp/responder.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { createReceiver } from '../src/hdtp/webhook.ts'
import { FakeNode, envelope, memoryLog, sign } from './fakes.ts'
import { TOKEN, closedPort, serve } from './wire.ts'

describe('the owner MCP over the wire', () => {
  const node = new FakeNode()
  let server: Server
  let url: string
  let unauthorized: () => number
  beforeAll(async () => {
    ;({ server, url, unauthorized } = await serve(node))
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('calls the tools by name with the bearer token, and reads refusals by code', async () => {
    node.thread('th1')
    node.inbound('th1', 'hello')
    const { node: client, disconnect } = connectNode(url, TOKEN)
    try {
      expect(await client.listAccounts()).toEqual(['acct-1'])
      expect((await client.getInbox('acct-1')).map((t) => t.thread_id)).toEqual(['th1'])
      expect((await client.readThread('acct-1', 'th1'))[0]).toMatchObject({ direction: 'in', body: 'hello' })
      const refused = await client.getInbox('acct-2').catch((e: unknown) => e)
      expect(refused).toBeInstanceOf(NodeRefusal)
      expect((refused as NodeRefusal).code).toBe('permission_denied')
    } finally {
      await disconnect()
    }
    expect(unauthorized()).toBe(0)
  })

  it('carries a signed message.received through to one reply on the node', async () => {
    node.thread('th2')
    node.inbound('th2', 'are you around?')
    const { node: client, disconnect } = connectNode(url, TOKEN)
    const tasks: Array<Promise<void>> = []
    const responder = new Responder(client, async () => 'Yes, Alex is around.', memoryLog())
    const receive = createReceiver({
      secret: () => 'whsec_x',
      log: memoryLog(),
      schedule: (t) => void tasks.push(t()),
      handlers: {
        message: (t) => responder.onMessage(t),
        reconcile: () => responder.reconcile(),
        request: (r) => responder.onRequest(r),
      },
    })
    try {
      const body = envelope('evt_wire', 'message.received', { thread_id: 'th2' })
      const t = Math.floor(Date.now() / 1000)
      const res = await receive(
        new Request('http://agent/hdtp/webhook', { method: 'POST', body, headers: { [SIGNATURE_HEADER]: sign(['whsec_x'], body, t) } }),
      )
      expect(res.status).toBe(202)
      await Promise.all(tasks)
      await responder.reconcile()
    } finally {
      await disconnect()
    }
    const replies = node.sent.filter((s) => s.thread_id === 'th2')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ account_id: 'acct-1', contact_fpr: 'fpr-contact', text: 'Yes, Alex is around.' })
    expect(replies[0]!.msg_id).toMatch(/^agent-reply-[0-9a-f]{32}$/)
  })

  it('names a refused token, and a node that cannot be reached, by code', async () => {
    const before = unauthorized()
    const wrong = connectNode(url, 'hdtp_wrong')
    try {
      const e = await wrong.node.listAccounts().catch((x: unknown) => x)
      expect(e).toBeInstanceOf(NodeRefusal)
      expect((e as NodeRefusal).code).toBe('owner_token_refused')
    } finally {
      await wrong.disconnect()
    }
    expect(unauthorized()).toBeGreaterThan(before)

    const port = await closedPort()
    const down = connectNode(`http://127.0.0.1:${port}/owner/mcp`, TOKEN)
    try {
      const e = await down.node.listAccounts().catch((x: unknown) => x)
      expect(e).toBeInstanceOf(NodeRefusal)
      expect((e as NodeRefusal).code).toBe('node_unreachable')
    } finally {
      await down.disconnect()
    }
  })

  it('reaches a node that comes up after the agent did, with the same client', async () => {
    const port = await closedPort()
    const { node: client, disconnect } = connectNode(`http://127.0.0.1:${port}/owner/mcp`, TOKEN)
    try {
      const first = await client.listAccounts().catch((x: unknown) => x)
      expect((first as NodeRefusal).code).toBe('node_unreachable')
      const up = await serve(new FakeNode(), port)
      try {
        expect(await client.listAccounts()).toEqual(['acct-1'])
      } finally {
        await new Promise<void>((r) => up.server.close(() => r()))
      }
    } finally {
      await disconnect()
    }
  })
})
