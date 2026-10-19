// The real client path: @mastra/mcp's MCPClient against an owner MCP served over HTTP as the node
// serves it (test/wire.ts).

import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeRefusal, TOOLS_CALLED, connectNode, decodeAnswer } from '../src/hdtp/node.ts'
import { missingTools } from '../src/hdtp/runtime.ts'
import { Responder } from '../src/hdtp/responder.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { createReceiver } from '../src/hdtp/webhook.ts'
import { FakeNode, TOOLS, ask, envelope, memoryLog, reply, rules, sign } from './fakes.ts'
import { LISTED, TOKEN, closedPort, deepSchema, listedWith, serve, wideSchema, type ListedTool } from './wire.ts'

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

  it('reads the rule a refusal names, as a code, over the wire', async () => {
    // A node of its own, so the thread it makes is in no other test's inbox.
    const own = new FakeNode()
    own.thread('th-rule')
    own.inbound('th-rule', 'Wednesday?')
    own.invalidSurfaces = 1
    const served = await serve(own)
    const { node: client, disconnect } = connectNode(served.url, TOKEN)
    try {
      const surface = (JSON.parse(ask('TLDR', { When: 'Wed' }, ['Wednesday works for me.'])) as { ask: { surface: unknown } }).ask.surface
      const refused = await client.askOwner({ account_id: 'acct-1', thread_id: 'th-rule', for_message_id: 'm-x', surface }).catch((e: unknown) => e)
      expect(refused).toMatchObject({ tool: 'ask_owner', code: 'bad_request', reason: 'invalid_surface:component_shape' })
    } finally {
      await disconnect()
      served.server.closeAllConnections()
      await new Promise<void>((r) => served.server.close(() => r()))
    }
  })

  it('keeps a refusal’s reason only when it is a code, and never its text', () => {
    const answer = (v: Record<string, unknown>) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'bad_request', ...v }) }] })
    const reason = (v: Record<string, unknown>) => {
      try {
        decodeAnswer('ask_owner', answer(v))
      } catch (e) {
        return (e as NodeRefusal).reason
      }
    }
    expect(reason({ reason: 'invalid_surface:prop_size' })).toBe('invalid_surface:prop_size')
    expect(reason({})).toBe('')
    for (const bad of ['Surface too large: 9000 bytes', 'invalid_surface:a:b', `invalid_surface:${'x'.repeat(60)}`, 'Invalid_surface', 7, null]) {
      expect(reason({ reason: bad }), String(bad)).toBe('')
    }
  })

  it('takes send_to_contact’s refusal as recorded only when it carries the message and its thread', () => {
    const answer = (v: Record<string, unknown>) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'unavailable', detail: 'refused', ...v }) }] })
    const recorded = (v: Record<string, unknown>, tool = 'send_to_contact') => {
      try {
        decodeAnswer(tool, answer(v))
      } catch (e) {
        return (e as NodeRefusal).recorded
      }
    }
    const sent = { status: 'pending', message_id: 'agent-reply-1', thread_id: 'th1' }
    expect(recorded(sent)).toBe(true)
    expect(recorded({ ...sent, status: 'failed' })).toBe(true)
    expect(recorded({ ...sent, message_id: '' })).toBe(false)
    expect(recorded({ status: 'pending', thread_id: 'th1' })).toBe(false)
    expect(recorded({ ...sent, thread_id: '' })).toBe(false)
    expect(recorded({ status: 'pending', message_id: 'agent-reply-1' })).toBe(false)
    expect(recorded(sent, 'ask_owner')).toBe(false)
    // The shape the node answered before #234: Go's field names, no message id.
    expect(recorded({ ThreadID: 'th1', Status: 'pending' })).toBe(false)
  })

  it('counts a send the node recorded and has yet to deliver as sent, and one it refused as refused, over the wire', async () => {
    // A node of its own, so its undelivered sends reach no other test.
    const own = new FakeNode()
    own.thread('th-send')
    own.inbound('th-send', 'lunch?')
    const served = await serve(own)
    const { node: client, disconnect } = connectNode(served.url, TOKEN)
    const send = (msg_id: string, thread_id = 'th-send') => client.sendToContact({ account_id: 'acct-1', contact_fpr: 'fpr-contact', thread_id, msg_id, text: 'Yes.' })
    try {
      await expect(send('m-delivered')).resolves.toBeUndefined()
      own.undelivered = true
      await expect(send('m-recorded')).resolves.toBeUndefined()
      expect(own.sent.map((s) => s.msg_id)).toEqual(['m-delivered', 'm-recorded'])
      await expect(send('m-nowhere', 'th-none')).rejects.toMatchObject({ tool: 'send_to_contact', code: 'not_found', recorded: false })
    } finally {
      await disconnect()
      served.server.closeAllConnections()
      await new Promise<void>((r) => served.server.close(() => r()))
    }
  })

  it('answers send_to_contact in exactly the node’s fields', async () => {
    const own = new FakeNode()
    own.thread('th-shape')
    const args = { account_id: 'acct-1', contact_fpr: 'fpr-contact', thread_id: 'th-shape', msg_id: 'm-1', text: 'Yes.' }
    const text = async () => JSON.parse((await own.call('send_to_contact', args)).content[0]!.text) as Record<string, unknown>
    expect(await text()).toEqual({ status: 'delivered', message_id: 'm-1', thread_id: 'th-shape' })
    own.undelivered = true
    const refused = await own.call('send_to_contact', args)
    expect(refused.isError).toBe(true)
    expect(Object.keys(await text()).sort()).toEqual(['code', 'detail', 'message_id', 'status', 'thread_id'])
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
        // The client names the dialect on every schema it reads; the node names it on the asks tools'.
        const { $schema: named, ...listed } = TOOLS.find((t) => t.name === name)!.inputSchema
        const { $schema: dialect, ...read } = await client.toolSchema(name)
        expect(read, name).toEqual(listed)
        if (named !== undefined) expect(dialect, name).toBe(named)
      }
      const missing = await client.toolSchema('no_such_tool').catch((e: unknown) => e)
      expect((missing as NodeRefusal).code).toBe('tool_not_offered')
      const responder = new Responder(client, async () => ask('Book Wed?', { When: 'Wed' }, ['Yes, book it']), memoryLog(), rules())
      await responder.onMessage('th3')
      expect(node.asks.filter((a) => a.thread_id === 'th3')).toHaveLength(1)
      expect((await client.listAsks('acct-1', 'th3')).map((a) => [a.thread_id, a.kind, a.status])).toEqual([['th3', 'ask', 'open']])
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

describe('the boot check over the wire', () => {
  // The listing the client takes from a node serving `tools`, held to the tools this agent calls.
  const missing = async (tools: ListedTool[]) => {
    const { server, url } = await serve(new FakeNode(), 0, tools)
    const { node: client, disconnect } = connectNode(url, TOKEN)
    try {
      return await missingTools(client)
    } finally {
      await disconnect()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  it('passes the node’s tools as listed', async () => {
    expect(await missing(LISTED)).toEqual({ tools: [], skipped: [] })
  })

  it('names a tool the client skipped, with the schema’s fault as a code', async () => {
    expect(await missing(listedWith('ask_owner', wideSchema(10_001)))).toEqual({
      tools: ['ask_owner'],
      skipped: ['ask_owner:schema_too_large'],
    })
    expect(await missing(listedWith('notify_owner', deepSchema(130)))).toEqual({
      tools: ['notify_owner'],
      skipped: ['notify_owner:schema_too_deep'],
    })
    expect(await missing(listedWith('list_asks', { type: 'object', properties: { thread_id: { type: 'no_such_type' } } }))).toEqual({
      tools: ['list_asks'],
      skipped: ['list_asks:schema_invalid'],
    })
  })

  it('reports only what the listing it read skipped, once the node is listed again', async () => {
    const tools = listedWith('ask_owner', wideSchema(10_001))
    const { server, url } = await serve(new FakeNode(), 0, tools)
    const { node: client, disconnect } = connectNode(url, TOKEN)
    try {
      expect((await client.listTools()).skipped).toEqual({ ask_owner: 'schema_too_large' })
      // The node is upgraded; a tool it does not offer makes the client list it again.
      tools.splice(0, tools.length, ...LISTED)
      expect(((await client.toolSchema('no_such_tool').catch((e: unknown) => e)) as NodeRefusal).code).toBe('tool_not_offered')
      expect(await client.listTools()).toEqual({ offered: LISTED.map((t) => t.name), skipped: {} })
    } finally {
      await disconnect()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('names a tool the node does not list, with no reason to give', async () => {
    expect(await missing(LISTED.filter((t) => t.name !== 'list_asks'))).toEqual({ tools: ['list_asks'], skipped: [] })
  })

  it('checks every tool node.ts calls', async () => {
    const source = readFileSync(new URL('../src/hdtp/node.ts', import.meta.url), 'utf8')
    const called = [...source.matchAll(/json\('([a-z_]+)'/g)].map((m) => m[1])
    expect([...TOOLS_CALLED].sort()).toEqual([...new Set(called)].sort())
  })
})
