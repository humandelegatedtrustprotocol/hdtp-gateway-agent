// What the Mastra CLI does with the entry file, and what the served process binds.
//
// `mastra dev` reads the entry file's `server` option in its own process: it bundles that option,
// and whatever it references, into a module and imports it there before it starts the served
// process. The first test runs the real `mastra dev` and counts the runtimes that reach the node,
// by their sweeps and by their wait_for_updates loops.
// The second imports the entry file and reads the server config the served process binds with
// (createNodeServer binds `mastra.getServer().host`, else MASTRA_HOST).
//
// Every run sets each HDTP_* variable the runtime reads, so the owner MCP is always a fake: a
// variable the environment already holds wins over a .env file under `mastra dev`.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeNode } from './fakes.ts'
import { TOKEN, closedPort, serve } from './wire.ts'

/** The owner MCP and the settings every run points at the fake, with a sweep only at start. */
function hdtpEnv(url: string): Record<string, string> {
  return {
    HDTP_OWNER_MCP_URL: url,
    HDTP_OWNER_TOKEN: TOKEN,
    HDTP_WEBHOOK_SECRET: 'whsec_cli-test',
    HDTP_RECONCILE_SECONDS: '3600',
    HDTP_PERSONA_FILE: resolve('persona.md'),
    MASTRA_TELEMETRY_DISABLED: '1',
  }
}

async function until(ready: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ready()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('timed out')
}

describe("the CLI's reading of the entry file", () => {
  it('starts one runtime under `mastra dev`: the served process, not the CLI', async () => {
    const node = new FakeNode()
    const { server, url } = await serve(node)
    const port = await closedPort()
    // A root of its own, inside the project so the bundle resolves its imports, keeps this run's
    // .mastra and dev lock apart from a `mastra dev` the developer has running.
    mkdirSync('.mastra', { recursive: true })
    const root = resolve(mkdtempSync(join('.mastra', 'cli-test-')))
    const dev = spawn('npx', ['mastra', 'dev', '--root', root, '--dir', resolve('src/mastra')], {
      env: { ...process.env, ...hdtpEnv(url), PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    })
    try {
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/hdtp/webhook`, { method: 'POST', body: '{}' })).status === 401
        } catch {
          return false
        }
      }, 90_000)
      // Each runtime sweeps the moment it starts, and its loop's first wait omits the cursor; give
      // a second one the time to reach the node.
      await new Promise((r) => setTimeout(r, 2_000))
      expect(node.waits.filter((w) => w.since === undefined)).toEqual([{ account: 'acct-1', since: undefined }])
      expect(node.calls.filter((c) => c === 'list_accounts')).toHaveLength(1)
    } finally {
      try {
        process.kill(-dev.pid!, 'SIGTERM')
      } catch {
        // already gone
      }
      await Promise.race([new Promise((r) => dev.once('exit', r)), new Promise((r) => setTimeout(r, 10_000))])
      rmSync(root, { recursive: true, force: true })
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 120_000)

  it('binds the loopback interface whatever MASTRA_HOST says', async () => {
    const { server, url } = await serve(new FakeNode())
    const vars = { ...hdtpEnv(url), MASTRA_HOST: '0.0.0.0' }
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
    // Before the import: the entry file reads its settings as it loads.
    Object.assign(process.env, vars)
    try {
      const { mastra } = await import('../src/mastra/index.ts')
      expect(mastra.getServer()?.host).toBe('127.0.0.1')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
