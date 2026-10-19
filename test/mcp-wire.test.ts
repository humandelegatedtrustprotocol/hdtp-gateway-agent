// The real client path: @mastra/mcp's MCPClient against an owner MCP served over HTTP as the node
// serves it (test/wire.ts).

import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeRefusal, connectNode } from '../src/hdtp/node.ts'
import { Responder } from '../src/hdtp/responder.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { createReceiver } from '../src/hdtp/webhook.ts'
import { FakeNode, TOOLS, ask, envelope, memoryLog, reply, rules, sign } from './fakes.ts'
import { TOKEN, closedPort, serve } from './wire.ts'

describe('the owner MCP over the wire', () => {
  const node = new FakeNode()
  let server: Server
  let url: string
  let unauthorized: () => number
  beforeAll(async () => {
    ;({ server, url, unauthorized } = await serve(node))
  })
  afterAll(() => {
    // A wait the client let go of is still held by the fake until its clock runs out.
    server.closeAllConnections()
    return new Promise<void>((r) => server.close(() => r()))
  })

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

  it('carries a signed message.received from a trusted contact through to one reply on the node', async () => {
    node.trust.set('fpr-contact', 'may_instruct')
    node.thread('th2')
    node.inbound('th2', 'are you around?')
    const { node: client, disconnect } = connectNode(url, TOKEN)
    const tasks: Array<Promise<void>> = []
    const responder = new Responder(client, async () => reply('Yes, Alex is around.'), memoryLog(), rules({ answer: 'trusted' }))
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

  it('reads the asks tools’ input schemas back as the node lists them, and puts an ask', async () => {
    node.thread('th3')
    node.inbound('th3', 'shall we book Wednesday?')
    const { node: client, disconnect } = connectNode(url, TOKEN)
    try {
      for (const name of ['send_to_contact', 'ask_owner', 'notify_owner']) {
        const listed = TOOLS.find((t) => t.name === name)!.inputSchema
        const { $schema: _dialect, ...read } = await client.toolSchema(name)
        expect(read, name).toEqual(listed)
      }
      const missing = await client.toolSchema('no_such_tool').catch((e: unknown) => e)
      expect((missing as NodeRefusal).code).toBe('tool_not_offered')
      const responder = new Responder(client, async () => ask('Book Wed?', { When: 'Wed' }, ['Yes, book it']), memoryLog(), rules())
      await responder.onMessage('th3')
      expect(node.asks.filter((a) => a.thread_id === 'th3')).toHaveLength(1)
      expect((await client.listAsks('acct-1', 'th3')).map((a) => a.status)).toEqual(['open'])
    } finally {
      await disconnect()
    }
  })

  it('waits from a cursor, and ends a held wait when its signal aborts', async () => {
    const { node: client, disconnect } = connectNode(url, TOKEN)
    try {
      const first = await client.waitForUpdates('acct-1', undefined)
      expect(first).toMatchObject({ threads: null, timed_out: false })
      const stop = new AbortController()
      const held = client.waitForUpdates('acct-1', first.cursor, stop.signal).catch((x: unknown) => x)
      await new Promise((r) => setTimeout(r, 200))
      const at = Date.now()
      stop.abort()
      expect(await held).toBeInstanceOf(NodeRefusal)
      expect(Date.now() - at).toBeLessThan(2_000)
      expect(node.waits.slice(-2)).toEqual([
        { account: 'acct-1', since: undefined },
        { account: 'acct-1', since: first.cursor },
      ])
    } finally {
      await disconnect()
    }
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
