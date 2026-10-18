import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, readConfig } from '../src/hdtp/config.ts'
import { FRAME } from '../src/hdtp/prompt.ts'
import { delegate, instructions } from '../src/mastra/agents/delegate.ts'

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

  it('routes to the configured model, openai/gpt-6-luna by default', () => {
    expect(DEFAULT_MODEL).toBe('openai/gpt-6-luna')
    expect(readConfig({}).model).toBe('openai/gpt-6-luna')
    expect(readConfig({ HDTP_AGENT_MODEL: 'anthropic/claude-opus-5-5' }).model).toBe('anthropic/claude-opus-5-5')
  })

  it('has no memory of its own', () => {
    expect(delegate.hasOwnMemory()).toBe(false)
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

  it('listens on 127.0.0.1 unless MASTRA_HOST opts in to another address', () => {
    expect(readConfig({}).host).toBe('127.0.0.1')
    expect(readConfig({ MASTRA_HOST: '' }).host).toBe('127.0.0.1')
    expect(readConfig({ MASTRA_HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  it('lists every variable it reads in .env.example', () => {
    const example = readFileSync('.env.example', 'utf8')
    const source = readFileSync('src/hdtp/config.ts', 'utf8')
    const read = [...source.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1])
    expect(read.length).toBeGreaterThan(0)
    for (const name of read) expect(example, String(name)).toMatch(new RegExp(`^${name}=`, 'm'))
  })
})
