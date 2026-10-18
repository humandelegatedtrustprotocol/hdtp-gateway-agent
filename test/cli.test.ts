// What the Mastra CLI does with the entry file before it starts the server: `mastra dev` and
// `mastra build` bundle its `server` option into a module of their own and import it in the CLI's
// process, through the same getServerOptions this test calls. @mastra/deployer comes with the
// mastra CLI, at the version package-lock.json pins.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { getServerOptions } from '@mastra/deployer/build'
import { describe, expect, it } from 'vitest'

describe("the CLI's reading of the entry file", () => {
  it('binds the loopback interface and starts no second runtime', async () => {
    let calls = 0
    const node = createServer((_req, res) => {
      calls++
      res.writeHead(401).end()
    })
    await new Promise<void>((r) => node.listen(0, '127.0.0.1', () => r()))
    const { port } = node.address() as AddressInfo
    const saved = { url: process.env.HDTP_OWNER_MCP_URL, token: process.env.HDTP_OWNER_TOKEN }
    process.env.HDTP_OWNER_MCP_URL = `http://127.0.0.1:${port}/owner/mcp`
    process.env.HDTP_OWNER_TOKEN = 'hdtp_cli-test'
    // Inside the project, as the CLI's own .mastra/output is, so the bundle resolves its imports.
    mkdirSync('.mastra', { recursive: true })
    const out = mkdtempSync(join('.mastra', 'cli-test-'))
    try {
      const server = await getServerOptions(resolve('src/mastra/index.ts'), resolve(out))
      expect(server?.host).toBe('127.0.0.1')
      // A runtime sweeps the moment it starts; give one the time to reach the node.
      await new Promise((r) => setTimeout(r, 500))
      expect(calls).toBe(0)
    } finally {
      process.env.HDTP_OWNER_MCP_URL = saved.url
      process.env.HDTP_OWNER_TOKEN = saved.token
      if (saved.url === undefined) delete process.env.HDTP_OWNER_MCP_URL
      if (saved.token === undefined) delete process.env.HDTP_OWNER_TOKEN
      rmSync(out, { recursive: true, force: true })
      await new Promise<void>((r) => node.close(() => r()))
    }
  }, 30_000)
})
