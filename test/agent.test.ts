import { readFileSync, readdirSync } from 'node:fs'
import { getProviderConfig, parseModelString } from '@mastra/core/llm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, readConfig } from '../src/hdtp/config.ts'
import { FRAME } from '../src/hdtp/prompt.ts'
import { delegate, instructions } from '../src/mastra/agents/delegate.ts'
import { bindHost, loopbackPeer, loopbackPeersOnly, studioHosts, studioOrigins } from '../src/mastra/origins.ts'

describe('the delegate agent', () => {
  it('is given no tools', async () => {
    expect(await delegate.listTools()).toEqual({})
  })

  it('is instructed by the frame, then the persona file', async () => {
    const persona = readFileSync('persona.md', 'utf8').trim()
    const got = await delegate.getInstructions()
    expect(got).toBe(`${FRAME}\n\n${persona}`)
    expect(instructions('persona.md')).toBe(got)
  })

  it('routes to the configured model, openrouter/openai/gpt-6-luna by default', () => {
    expect(DEFAULT_MODEL).toBe('openrouter/openai/gpt-6-luna')
    expect(readConfig({}).model).toBe('openrouter/openai/gpt-6-luna')
    expect(readConfig({ HDTP_AGENT_MODEL: 'anthropic/claude-opus-5-5' }).model).toBe('anthropic/claude-opus-5-5')
  })

  it('defaults to a model the installed router lists, with the key .env.example names', () => {
    const { provider, modelId } = parseModelString(DEFAULT_MODEL)
    const router = getProviderConfig(provider ?? '')
    expect(provider).toBe('openrouter')
    expect(router?.models).toContain(modelId)
    expect(router?.apiKeyEnvVar).toBe('OPENROUTER_API_KEY')
    const example = readFileSync('.env.example', 'utf8')
    expect(example).toMatch(new RegExp(`^HDTP_AGENT_MODEL=${DEFAULT_MODEL}$`, 'm'))
    expect(example).toMatch(new RegExp(`^${router?.apiKeyEnvVar}=$`, 'm'))
  })

  it('has no memory of its own', () => {
    expect(delegate.hasOwnMemory()).toBe(false)
  })
})

describe('the personas', () => {
  const examples = readdirSync('examples/personas').filter((f) => f.endsWith('.md'))
  const files = ['persona.md', ...examples.map((f) => `examples/personas/${f}`)]

  it('cover the seven use cases, both sides of each', () => {
    const cases = new Map<string, number>()
    for (const f of examples) {
      const u = /^u([1-7])-/.exec(f)?.[1]
      expect(u, f).toBeDefined()
      cases.set(u!, (cases.get(u!) ?? 0) + 1)
    }
    expect([...cases.entries()].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7'].map((u) => [u, 2]))
  })

  it('each load as the instructions, and give every topic of their autonomy one of the two stances', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(instructions(f), f).toBe(`${FRAME}\n\n${text.trim()}`)
      const autonomy = text.split(/^## Autonomy$/m)[1]
      expect(autonomy, f).toBeDefined()
      const topics = autonomy!.split(/^## /m)[0]!.split('\n').filter((l) => l.startsWith('- '))
      expect(topics.length, f).toBeGreaterThan(0)
      for (const t of topics) expect(t, f).toMatch(/^- [^:]+: (ask before committing|commit within limits and notify)\./)
    }
  })
})

describe('the configuration', () => {
  it('defaults to the node’s internal listener and a 60 s sweep, and refuses a sweep that is not whole seconds', () => {
    const c = readConfig({})
    expect(c.ownerMcpUrl).toBe('http://127.0.0.1:8080/owner/mcp')
    expect(c.reconcileSeconds).toBe(60)
    expect(c.ownerToken).toBeUndefined()
    expect(c.webhookSecret).toBeUndefined()
    expect(readConfig({ HDTP_RECONCILE_SECONDS: '15' }).reconcileSeconds).toBe(15)
    expect(readConfig({ HDTP_RECONCILE_SECONDS: '0' }).reconcileSeconds).toBe(60)
    expect(readConfig({ HDTP_RECONCILE_SECONDS: '1.5' }).reconcileSeconds).toBe(60)
  })

  it('caps agent-to-agent turns at 3 by default, and at a whole number above 0 when set', () => {
    expect(readConfig({}).agentTurnCap).toBe(3)
    expect(readConfig({ HDTP_AGENT_TURN_CAP: '5' }).agentTurnCap).toBe(5)
    expect(readConfig({ HDTP_AGENT_TURN_CAP: '0' }).agentTurnCap).toBe(3)
    expect(readConfig({ HDTP_AGENT_TURN_CAP: '2.5' }).agentTurnCap).toBe(3)
  })

  it('allows 10 drafts per contact per hour by default, and a whole number above 0 when set', () => {
    expect(readConfig({}).repliesPerHour).toBe(10)
    expect(readConfig({ HDTP_AGENT_REPLIES_PER_HOUR: '2' }).repliesPerHour).toBe(2)
    expect(readConfig({ HDTP_AGENT_REPLIES_PER_HOUR: '0' }).repliesPerHour).toBe(10)
  })

  it('keeps its data in ./data by default, or where HDTP_AGENT_DATA_DIR says', () => {
    expect(readConfig({}).dataDir).toBe('data')
    expect(readConfig({ HDTP_AGENT_DATA_DIR: '/var/lib/agent' }).dataDir).toBe('/var/lib/agent')
  })

  it('answers trusted contacts only unless HDTP_AGENT_ANSWER is exactly all', () => {
    expect(readConfig({}).answer).toBe('trusted')
    expect(readConfig({ HDTP_AGENT_ANSWER: 'all' }).answer).toBe('all')
    expect(readConfig({ HDTP_AGENT_ANSWER: ' all ' }).answer).toBe('all')
    for (const v of ['trusted', 'ALL', 'everyone', '']) expect(readConfig({ HDTP_AGENT_ANSWER: v }).answer, v).toBe('trusted')
  })

  it('lists every variable it reads in .env.example', () => {
    const example = readFileSync('.env.example', 'utf8')
    const source = readFileSync('src/hdtp/config.ts', 'utf8')
    const read = [...source.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1])
    expect(read.length).toBeGreaterThan(0)
    for (const name of read) expect(example, String(name)).toMatch(new RegExp(`^${name}=`, 'm'))
  })
})

describe("Studio's hosts and origins", () => {
  it('are on PORT, and on 4111 without it, as the server binds', () => {
    expect(studioHosts({})).toEqual(['localhost:4111', '127.0.0.1:4111'])
    expect(studioHosts({ PORT: '4300' })).toEqual(['localhost:4300', '127.0.0.1:4300'])
    expect(studioOrigins({})).toEqual(['http://localhost:4111', 'http://127.0.0.1:4111'])
    expect(studioOrigins({ PORT: '4300' })).toEqual(['http://localhost:4300', 'http://127.0.0.1:4300'])
  })

  it('are served on the loopback interface unless MASTRA_HOST names another address', () => {
    expect(bindHost({})).toBe('127.0.0.1')
    expect(bindHost({ MASTRA_HOST: ' ' })).toBe('127.0.0.1')
    expect(bindHost({ MASTRA_HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })
})

/**
 * Runs the peer rule as Mastra's Node server does: the socket a request came on is the context's
 * `env.incoming.socket`. Answers 'next' when the rule lets the request through.
 */
async function peerRule(remoteAddress: string | undefined, env?: unknown): Promise<'next' | { status: number; body: unknown }> {
  const c = {
    env: env ?? { incoming: { socket: { remoteAddress } } },
    json: (body: unknown, status: number) => Response.json(body, { status }),
  }
  let passed = false
  const res = (await loopbackPeersOnly(c as never, async () => {
    passed = true
  })) as Response | undefined
  return passed ? 'next' : { status: res!.status, body: await res!.json() }
}

describe('the peer rule', () => {
  it('knows the loopback interface in each form a socket names it', () => {
    for (const address of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      expect(loopbackPeer(address), address).toBe(true)
    }
    for (const address of [undefined, '', '172.18.0.3', '10.127.0.1', '::ffff:172.18.0.3', '::2', 'fe80::1', '128.0.0.1']) {
      expect(loopbackPeer(address), String(address)).toBe(false)
    }
  })

  it('lets a loopback peer through and refuses any other, and a request with no socket, by its code', async () => {
    expect(await peerRule('127.0.0.1')).toBe('next')
    expect(await peerRule('::1')).toBe('next')
    const refused = { status: 403, body: { code: 'peer_refused' } }
    expect(await peerRule('172.18.0.3')).toEqual(refused)
    expect(await peerRule(undefined)).toEqual(refused)
    expect(await peerRule(undefined, {})).toEqual(refused)
  })
})
