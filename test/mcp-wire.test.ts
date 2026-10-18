// The real client path: @mastra/mcp's MCPClient against an owner MCP served over HTTP as the node
// serves it. owner-mcp-tools.json is the node's tools/list for the six tools this agent calls,
// captured from hdtp-gateway 4906e99 on 2026-10-18. Like the node, the server answers
// server/discover with "method not found" and keeps no session.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeRefusal, connectNode } from '../src/hdtp/node.ts'
import { Responder } from '../src/hdtp/responder.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { createReceiver } from '../src/hdtp/webhook.ts'
import { FakeNode, envelope, memoryLog, sign } from './fakes.ts'

const TOKEN = 'hdtp_test-token'
const tools = JSON.parse(readFileSync(new URL('./owner-mcp-tools.json', import.meta.url), 'utf8')) as Array<{ name: string }>

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function serve(node: FakeNode): Promise<{ server: Server; url: string; unauthorized: () => number }> {
  let unauthorized = 0
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      unauthorized++
      res.writeHead(401).end('a bearer token is required')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const msg = JSON.parse(await bodyOf(req)) as { id?: number; method: string; params?: Record<string, unknown> }
    if (msg.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const reply = (body: Record<string, unknown>) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }))
    switch (msg.method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { resources: {}, tools: {} },
            serverInfo: { name: 'hdtp-gateway-owner', version: '1' },
          },
        })
      case 'tools/list':
        return reply({ result: { tools } })
      case 'tools/call': {
        const p = msg.params as { name: string; arguments: Record<string, unknown> }
        return reply({ result: await node.call(p.name, p.arguments ?? {}) })
      }
      default:
        return reply({ error: { code: -32601, message: `method not found: "${msg.method}"` } })
    }
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}/owner/mcp`, unauthorized: () => unauthorized })
    }),
  )
}

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

    const closed = await new Promise<string>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo
        s.close(() => resolve(`http://127.0.0.1:${port}/owner/mcp`))
      })
    })
    const down = connectNode(closed, TOKEN)
    try {
      const e = await down.node.listAccounts().catch((x: unknown) => x)
      expect(e).toBeInstanceOf(NodeRefusal)
      expect((e as NodeRefusal).code).toBe('node_unreachable')
    } finally {
      await down.disconnect()
    }
  })
})
