// The server `mastra build` bundles, built from the entry file by the same @mastra/deployer
// (createHonoServer), asked as Mastra's Node server asks it: the socket a request came on is the
// context's `env.incoming.socket`. A caller on another host (a sibling container) is the peer
// 172.18.0.3; it names Studio's host, as a caller that knows the host rule would.
//
// Mastra runs no middleware on the routes it declares public, so the peer rule cannot refuse them:
// the webhook, and Mastra's own auth routes. Those are held here to the answers they give with no
// auth provider, which carry nothing of the agent's; a Mastra that adds a public route, or makes
// one of them answer something else, turns this red.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHonoServer } from '@mastra/deployer/server'
import { SERVER_ROUTES } from '@mastra/server/server-adapter'
import { beforeAll, describe, expect, it } from 'vitest'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { envelope, sign } from './fakes.ts'

const WEBHOOK_SECRET = 'whsec_peer-test'
const FAR = { incoming: { socket: { remoteAddress: '172.18.0.3' } } }
const NEAR = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const STUDIO_HOST = '127.0.0.1:4111'

/** What each of Mastra's public routes answers with no auth provider, measured on Mastra 1.78.0. */
const PUBLIC_ANSWERS: Record<string, { status: number; body: unknown; location?: string }> = {
  'GET /api/auth/capabilities': { status: 200, body: { enabled: false, login: null } },
  'GET /api/auth/me': { status: 200, body: null },
  'GET /api/auth/sso/login': { status: 404, body: { error: 'SSO not configured' } },
  'GET /api/auth/sso/callback': { status: 302, body: '', location: 'http://127.0.0.1:4111/?error=sso_not_configured' },
  'POST /api/auth/logout': { status: 404, body: { error: 'Logout not configured' } },
  'POST /api/auth/refresh': { status: 404, body: { error: 'Session refresh not configured' } },
  'POST /api/auth/credentials/sign-in': { status: 404, body: { error: 'Credentials authentication not configured' } },
  'POST /api/auth/credentials/sign-up': { status: 404, body: { error: 'Credentials authentication not configured' } },
}

/** A body each public route takes as well formed, so it answers past its own validation. */
const CREDENTIALS = JSON.stringify({ email: 'probe@example.com', password: 'probe-password', name: 'probe' })

type App = Awaited<ReturnType<typeof createHonoServer>>
let app: App
let custom: { method: string; path: string; requiresAuth?: boolean }[] = []

beforeAll(async () => {
  // Before the import: the entry file reads its settings as it loads. No owner token, so the
  // runtime stays idle and reaches no node.
  Object.assign(process.env, {
    HDTP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    HDTP_PERSONA_FILE: resolve('persona.md'),
    HDTP_AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), 'hdtp-agent-data-')),
    MASTRA_TELEMETRY_DISABLED: '1',
  })
  delete process.env.HDTP_OWNER_TOKEN
  delete process.env.PORT
  const { mastra } = await import('../src/mastra/index.ts')
  app = await createHonoServer(mastra, { tools: {} })
  custom = mastra.getServer()?.apiRoutes ?? []
}, 60_000)

function ask(peer: typeof FAR, method: string, path: string, host = STUDIO_HOST, headers: Record<string, string> = {}, body?: string) {
  return app.fetch(new Request(`http://${host}${path}`, { method, headers: { Host: host, ...headers }, body }), peer)
}

/** A route's path with each parameter filled in, and its method as a request names it. */
function concrete(r: { method: string; path: string }): [string, string] {
  return [r.method === 'ALL' ? 'GET' : r.method.toUpperCase(), `/api${r.path.replace(/:[A-Za-z]+\??/g, 'x')}`]
}

describe('a caller on another host', () => {
  it('is refused on every route of Mastra that is not public, whatever host it names', async () => {
    const refused = SERVER_ROUTES.filter((r) => r.requiresAuth !== false)
    expect(refused.length).toBeGreaterThan(0)
    const routes: [string, string][] = [...refused.map(concrete), ['GET', '/'], ['GET', '/health'], ['GET', '/api'], ['GET', '/hdtp/webhook']]
    for (const [method, path] of routes) {
      for (const host of [STUDIO_HOST, 'agent:4111']) {
        const body = method === 'GET' || method === 'HEAD' ? undefined : '{}'
        const res = await ask(FAR, method, path, host, { 'Content-Type': 'application/json' }, body)
        expect(res.status, `${method} ${path} ${host}`).toBe(403)
        expect(await res.json(), `${method} ${path} ${host}`).toEqual({ code: 'peer_refused' })
      }
    }
  })

  it("gets from Mastra's public routes only their answers with no auth provider", async () => {
    const open = SERVER_ROUTES.filter((r) => r.requiresAuth === false).map((r) => concrete(r).join(' '))
    expect(open.sort()).toEqual(Object.keys(PUBLIC_ANSWERS).sort())
    for (const [route, want] of Object.entries(PUBLIC_ANSWERS)) {
      const [method, path] = route.split(' ')
      const query = path!.endsWith('/callback') ? '?code=probe&state=probe' : ''
      const res = await ask(FAR, method!, path! + query, STUDIO_HOST, { 'Content-Type': 'application/json' }, method === 'POST' ? CREDENTIALS : undefined)
      expect(res.status, route).toBe(want.status)
      const text = await res.text()
      expect(text === '' ? '' : JSON.parse(text), route).toEqual(want.body)
      if (want.location) expect(res.headers.get('location'), route).toBe(want.location)
    }
  })

  it("reaches the webhook, which checks the node's signature", async () => {
    // The agent's only public route of its own.
    expect(custom.filter((r) => r.requiresAuth === false).map((r) => `${r.method} ${r.path}`)).toEqual(['POST /hdtp/webhook'])
    const unsigned = await ask(FAR, 'POST', '/hdtp/webhook', 'agent:4111', {}, '{}')
    expect(unsigned.status).toBe(401)
    expect(await unsigned.json()).toEqual({ code: 'bad_signature' })
    // A signed event the agent does not act on, so no model is called.
    const event = envelope('evt_peer-check', 'message.delivered', {})
    const signed = { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: sign([WEBHOOK_SECRET], event, Math.floor(Date.now() / 1000)) }
    const res = await ask(FAR, 'POST', '/hdtp/webhook', 'agent:4111', signed, event)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
  })
})

describe('a caller on the loopback interface', () => {
  it("is answered by Mastra's API", async () => {
    const res = await ask(NEAR, 'GET', '/api/agents')
    expect(res.status).toBe(200)
    expect(Object.keys((await res.json()) as object)).toEqual(['delegate'])
  })
})
