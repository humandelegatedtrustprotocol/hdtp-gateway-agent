// What the Mastra CLI does with the entry file before it starts the server: `mastra dev` and
// `mastra build` bundle its `server` option into a module of their own and import it in the CLI's
// process, through the same getServerOptions this test calls. @mastra/deployer comes with the
// mastra CLI, at the version package-lock.json pins.
//
// Every run points the owner MCP at a fake that counts calls, so no run can reach a real node.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { getServerOptions } from '@mastra/deployer/build'
import { describe, expect, it } from 'vitest'

/** The CLI's reading of the server option under `env`, and the calls a node received meanwhile. */
async function readServerOption(env: Record<string, string>) {
  let calls = 0
  const node = createServer((_req, res) => {
    calls++
    res.writeHead(401).end()
  })
  await new Promise<void>((r) => node.listen(0, '127.0.0.1', () => r()))
  const { port } = node.address() as AddressInfo
  const vars = { HDTP_OWNER_MCP_URL: `http://127.0.0.1:${port}/owner/mcp`, HDTP_OWNER_TOKEN: 'hdtp_cli-test', ...env }
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  // Inside the project, as the CLI's own .mastra/output is, so the bundle resolves its imports.
  mkdirSync('.mastra', { recursive: true })
  const out = mkdtempSync(join('.mastra', 'cli-test-'))
  try {
    const server = await getServerOptions(resolve('src/mastra/index.ts'), resolve(out))
    // A runtime sweeps the moment it starts; give one the time to reach the node.
    await new Promise((r) => setTimeout(r, 500))
    return { server, calls }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(out, { recursive: true, force: true })
    await new Promise<void>((r) => node.close(() => r()))
  }
}

describe("the CLI's reading of the entry file", () => {
  it('binds the loopback interface and starts no second runtime', async () => {
    const { server, calls } = await readServerOption({})
    expect(server?.host).toBe('127.0.0.1')
    expect(calls).toBe(0)
  }, 30_000)

  it('binds the loopback interface whatever MASTRA_HOST says', async () => {
    const { server, calls } = await readServerOption({ MASTRA_HOST: '0.0.0.0' })
    expect(server?.host).toBe('127.0.0.1')
    expect(calls).toBe(0)
  }, 30_000)
})
