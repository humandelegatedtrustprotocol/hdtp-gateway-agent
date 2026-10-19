// An owner MCP served over HTTP as the node serves it, backed by a FakeNode. owner-mcp-tools.json
// is the node's tools/list for the seven tools this agent calls: six captured from hdtp-gateway
// 4906e99 on 2026-10-18, and wait_for_updates from 2170fda on 2026-10-19. Like the node, the server answers server/discover with "method not found" and
// keeps no session.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import type { FakeNode } from './fakes.ts'

export const TOKEN = 'hdtp_test-token'
const tools = JSON.parse(readFileSync(new URL('./owner-mcp-tools.json', import.meta.url), 'utf8')) as Array<{ name: string }>

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function serve(node: FakeNode, port = 0): Promise<{ server: Server; url: string; unauthorized: () => number }> {
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
    server.listen(port, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}/owner/mcp`, unauthorized: () => unauthorized })
    }),
  )
}

/** A port nothing listens on: bound, then closed. */
export function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}
