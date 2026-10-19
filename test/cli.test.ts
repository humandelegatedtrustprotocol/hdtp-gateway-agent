// What the Mastra CLI does with the entry file, and what the served process binds.
//
// `mastra dev` reads the entry file's `server` option in its own process: it bundles that option,
// and whatever it references, into a module and imports it there before it starts the served
// process. The first tests run the real `mastra dev`: they count the runtimes that reach the node,
// by their sweeps and by their wait_for_updates loops, and read the CORS answers of its /api.
// The last imports the entry file and reads the server config the served process binds with
// (createNodeServer binds `mastra.getServer().host`, else MASTRA_HOST).
//
// Every run sets each HDTP_* variable the runtime reads, so the owner MCP is always a fake: a
// variable the environment already holds wins over a .env file under `mastra dev`.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

/** How much of the dev process's output a failing run prints. */
const OUTPUT_KEPT = 20_000

/** Signals a process group, which may be gone already. */
function kill(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(group, signal)
  } catch {
    // already gone
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

describe('the served process under `mastra dev`', () => {
  const node = new FakeNode()
  let server: Server
  let port = 0
  let output = ''
  let stop = async () => {}
  beforeAll(async () => {
    let url: string
    ;({ server, url } = await serve(node))
    port = await closedPort()
    // A root of its own, inside the project so the bundle resolves its imports, keeps this run's
    // .mastra and dev lock apart from a `mastra dev` the developer has running.
    mkdirSync('.mastra', { recursive: true })
    const root = resolve(mkdtempSync(join('.mastra', 'cli-test-')))
    // Its own process group, so the kill below reaches the CLI and the process it serves. A vitest
    // that is itself killed runs no finally, and leaves that group running.
    const dev = spawn('npx', ['mastra', 'dev', '--root', root, '--dir', resolve('src/mastra')], {
      env: { ...process.env, ...hdtpEnv(url), PORT: String(port) },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_KEPT)
    }
    dev.stdout!.on('data', keep)
    dev.stderr!.on('data', keep)
    const exited = new Promise((r) => dev.once('exit', r))
    stop = async () => {
      kill(-dev.pid!, 'SIGTERM')
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))])
      if (!gone) kill(-dev.pid!, 'SIGKILL')
      rmSync(root, { recursive: true, force: true })
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
    try {
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/hdtp/webhook`, { method: 'POST', body: '{}' })).status === 401
        } catch {
          return false
        }
      }, 90_000)
    } catch (e) {
      console.error(`mastra dev's output (its last ${OUTPUT_KEPT} characters):\n${output}`)
      throw e
    }
  }, 120_000)
  afterAll(() => stop(), 30_000)

  /** Prints the dev process's output when the check fails. */
  async function showing(check: () => Promise<void>): Promise<void> {
    try {
      await check()
    } catch (e) {
      console.error(`mastra dev's output (its last ${OUTPUT_KEPT} characters):\n${output}`)
      throw e
    }
  }

  it('starts one runtime: the served process, not the CLI', () =>
    showing(async () => {
      // Each runtime sweeps the moment it starts, and its loop's first wait omits the cursor; give
      // a second one the time to reach the node.
      await new Promise((r) => setTimeout(r, 2_000))
      expect(node.waits.filter((w) => w.since === undefined)).toEqual([{ account: 'acct-1', since: undefined }])
      expect(node.calls.filter((c) => c === 'list_accounts')).toHaveLength(1)
    }))

  it("answers /api to Studio's two origins, and gives any other origin no Access-Control-Allow-Origin", () =>
    showing(async () => {
      const api = `http://127.0.0.1:${port}/api/agents`
      const allowed = (res: Response) => res.headers.get('access-control-allow-origin')
      for (const origin of ['http://localhost:4111', 'http://127.0.0.1:4111']) {
        const res = await fetch(api, { headers: { Origin: origin } })
        expect(res.status, origin).toBe(200)
        expect(allowed(res), origin).toBe(origin)
      }
      for (const origin of ['https://example.com', 'http://localhost:4199', 'null']) {
        const res = await fetch(api, { headers: { Origin: origin } })
        expect(allowed(res), origin).toBeNull()
        // The preflight a browser sends before a cross-origin POST with a JSON body.
        const pre = await fetch(`http://127.0.0.1:${port}/api/agents/delegate/generate`, {
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
        })
        expect(allowed(pre), origin).toBeNull()
      }
    }))
})

describe("the CLI's reading of the entry file", () => {
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
