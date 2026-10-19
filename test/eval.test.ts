// The turn eval's points and runner, held with no model: eval/run.ts makes real calls and runs
// only by hand, so what it drafts for is checked here on every commit.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CEILING, PERSONAS, POINTS, passes, plan, promptFor } from '../eval/points.ts'
import { FIRST_TURNS } from '../src/hdtp/responder.ts'
import { Turns } from '../src/hdtp/turn.ts'
import { TOOLS } from './fakes.ts'

const turns = new Turns({ toolSchema: async (name) => TOOLS.find((t) => t.name === name)!.inputSchema })
const conversation = (prompt: string) => JSON.parse(prompt.split('```')[1]!.replace(/^json\n/, '')) as Array<{ from: string; text: string }>

describe('the turn eval', () => {
  it('drafts for a contact’s newest message at every point, with a persona that exists and turns that are offered', async () => {
    const schema = await turns.schema()
    expect(POINTS).toHaveLength(10)
    for (const p of POINTS) {
      expect(p.messages.at(-1)!.direction, p.id).toBe('in')
      expect(existsSync(PERSONAS[p.persona]), p.id).toBe(true)
      for (const e of p.expected) expect([...FIRST_TURNS, 'notify+reply'], p.id).toContain(e)
      expect(promptFor(p, schema), p.id).toContain('Choose one of these turns: reply, ask, notify, none.')
    }
  })

  it('shows Ana’s yes as hers on her side and as the contact’s on Ben’s', async () => {
    const schema = await turns.schema()
    const yes = (id: string) => conversation(promptFor(POINTS.find((p) => p.id === id)!, schema)).find((m) => m.text.startsWith('Yes, Wednesday'))!.from
    expect(yes('u1-5')).toBe('person')
    expect(yes('u1-4')).toBe('contact')
  })

  it('tells a notice with a reply from one without', () => {
    const u53 = POINTS.find((p) => p.id === 'u5-3')!
    expect(passes(u53, { type: 'notify', notice: {}, reply: 'Booked.' })).toBe(true)
    expect(passes(u53, { type: 'notify', notice: {} })).toBe(false)
    expect(passes(u53, { type: 'reply', text: 'Booked.' })).toBe(false)
  })

  it('makes at most CEILING calls a run', () => {
    expect(plan(5)).toHaveLength(10)
    expect(POINTS.length * 5).toBe(CEILING)
    expect(() => plan(6)).toThrow(/over 50 calls/)
    expect(() => plan(0)).toThrow()
    expect(plan(50, ['u1-3'])).toHaveLength(1)
    expect(() => plan(1, ['u9-9'])).toThrow(/unknown point/)
  })

  it('runs dry with no model and no key', () => {
    const run = spawnSync(process.execPath, ['eval/run.ts', '--dry'], { env: { ...process.env, OPENROUTER_API_KEY: '' }, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/^dry: 10 points x 5 runs = 50 calls/)
  })
})
