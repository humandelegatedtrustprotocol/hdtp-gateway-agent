// What the Mastra CLI does with the entry file, and what the served process binds.
//
// `mastra dev` reads the entry file's `server` option in its own process: it bundles that option,
// and whatever it references, into a module and imports it there before it starts the served
// process. The first tests run the real `mastra dev`: they count the runtimes that reach the node,
// by their sweeps and by their wait_for_updates loops, read the CORS answers of its /api and its
// refusal of a write from another origin, and send requests to another host, which it refuses.
// The last imports the entry file and reads the server config the served process binds with
// (createNodeServer binds `mastra.getServer().host`, else MASTRA_HOST).
//
// Every run sets each HDTP_* variable the runtime reads, so the owner MCP is always a fake: a
// variable the environment already holds wins over a .env file under `mastra dev`.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FRAME } from '../src/hdtp/prompt.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { FakeNode, envelope, sign } from './fakes.ts'
import { TOKEN, closedPort, serve } from './wire.ts'

const WEBHOOK_SECRET = 'whsec_cli-test'

/** The owner MCP and the settings every run points at the fake, with a sweep only at start. */
function hdtpEnv(url: string): Record<string, string> {
  return {
    HDTP_OWNER_MCP_URL: url,
    HDTP_OWNER_TOKEN: TOKEN,
    HDTP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    HDTP_RECONCILE_SECONDS: '3600',
    HDTP_PERSONA_FILE: resolve('persona.md'),
    HDTP_AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), 'hdtp-agent-data-')),
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

/**
 * A request to 127.0.0.1:`port` naming `host` in its Host header, which fetch does not let a caller
 * set: a page that rebinds its own name to 127.0.0.1 names its own host there.
 */
function hostRequest(
  port: number,
  host: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...headers, Host: host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => done({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', fail)
    req.end(body)
  })
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

  it("answers /api to Studio's two origins on the port it binds, and gives any other origin no Access-Control-Allow-Origin", () =>
    showing(async () => {
      // A port of its own, not the default: Studio's origins follow it, and 4111's are any other.
      expect(port).not.toBe(4111)
      const api = `http://127.0.0.1:${port}/api/agents`
      const allowed = (res: Response) => res.headers.get('access-control-allow-origin')
      for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
        const res = await fetch(api, { headers: { Origin: origin } })
        expect(res.status, origin).toBe(200)
        expect(allowed(res), origin).toBe(origin)
      }
      for (const origin of ['https://example.com', 'http://localhost:4111', 'http://127.0.0.1:4111', 'null']) {
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

  it("refuses a write from any other origin, in the bodies a browser sends with no preflight, and takes Studio's", () =>
    showing(async () => {
      const api = `http://127.0.0.1:${port}/api/agents/delegate`
      const model = async () => {
        const a = (await (await fetch(api)).json()) as { provider: string; modelId: string }
        return `${a.provider}/${a.modelId}`
      }
      const before = await model()
      const change = { provider: 'openrouter', modelId: 'cross-origin/probe' }
      const form = () => {
        const f = new FormData()
        for (const [k, v] of Object.entries(change)) f.append(k, v)
        return f
      }
      for (const origin of ['https://example.com', 'http://localhost:4111', 'http://127.0.0.1:4111', 'null']) {
        // A multipart form, and text/plain whose content type names JSON in a parameter: Mastra
        // reads both as the body, and a browser sends both without asking first.
        for (const init of [
          { body: form() },
          { body: JSON.stringify(change), headers: { 'Content-Type': 'text/plain; a=application/json' } },
        ]) {
          const res = await fetch(`${api}/model`, { method: 'POST', ...init, headers: { ...init.headers, Origin: origin } })
          expect(res.status, origin).toBe(403)
          expect(await res.json()).toEqual({ code: 'origin_refused' })
        }
        expect(await model(), origin).toBe(before)
      }
      // Studio's own writes go through, from both of its addresses.
      const studio = { 'Content-Type': 'application/json' }
      const set = await fetch(`${api}/model`, {
        method: 'POST',
        headers: { ...studio, Origin: `http://localhost:${port}` },
        body: JSON.stringify({ provider: 'openrouter', modelId: 'studio/choice' }),
      })
      expect(set.status).toBe(200)
      expect(await model()).toBe('openrouter/studio/choice')
      const reset = await fetch(`${api}/model/reset`, { method: 'POST', headers: { ...studio, Origin: `http://127.0.0.1:${port}` }, body: '{}' })
      expect(reset.status).toBe(200)
      expect(await model()).toBe(before)
    }))

  it("refuses every request to a host that is not Studio's, reads included, and lets the webhook name any host", () =>
    showing(async () => {
      const json = { 'Content-Type': 'application/json' }
      const model = async (host: string) => {
        const res = await hostRequest(port, host, 'GET', '/api/agents/delegate')
        expect(res.status, host).toBe(200)
        const a = JSON.parse(res.body) as { provider: string; modelId: string; instructions: string }
        expect(a.instructions, host).toContain(FRAME.split('\n')[0])
        return `${a.provider}/${a.modelId}`
      }
      // Studio's two addresses: its page and its API.
      const [localhost, loopback] = [`localhost:${port}`, `127.0.0.1:${port}`]
      for (const host of [localhost, loopback]) {
        expect((await hostRequest(port, host, 'GET', '/')).status, host).toBe(200)
        await model(host)
      }
      const before = await model(localhost)
      // A rebound name, the compose project's name for the agent, and Studio's name on another port.
      for (const host of [`evil.example:${port}`, `agent:${port}`, `localhost:${port + 1}`]) {
        for (const path of ['/api/agents/delegate', '/api/agents', '/', '/health']) {
          const res = await hostRequest(port, host, 'GET', path)
          expect(res.status, `${host} ${path}`).toBe(403)
          expect(JSON.parse(res.body), `${host} ${path}`).toEqual({ code: 'host_refused' })
        }
        // A write without an Origin, which the origin rule lets through: the host rule refuses it.
        const body = JSON.stringify({ provider: 'openrouter', modelId: 'rebound/probe' })
        const res = await hostRequest(port, host, 'POST', '/api/agents/delegate/model', json, body)
        expect(res.status, host).toBe(403)
        expect(JSON.parse(res.body), host).toEqual({ code: 'host_refused' })
        expect(await model(loopback), host).toBe(before)
      }
      // The node posts its webhook to the address its endpoint names: http://agent:4111 inside a
      // compose project. A signed event the agent does not act on, so no model is called.
      const event = envelope('evt_host-check', 'message.delivered', {})
      const signed = { ...json, [SIGNATURE_HEADER]: sign([WEBHOOK_SECRET], event, Math.floor(Date.now() / 1000)) }
      const res = await hostRequest(port, 'agent:4111', 'POST', '/hdtp/webhook', signed, event)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ status: 'ignored' })
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
