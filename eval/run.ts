// The turn eval: drafts the turn at each point of eval/points.ts through the agent's own path (the
// frame and an example persona as the instructions, the configured model, the drafter with its
// output cap, the turn read against the node's schema as test/owner-mcp-tools.json captured it),
// `runs` times each, and says per point how many turns were of a passing type and how many were
// valid. Every call is one model call, never retried; one line of JSON per call goes to stdout,
// for reading the ready replies, and the summary to stderr.
//
//   make eval                       5 runs of every point: 55 calls, the most one run makes
//   make eval EVAL='--runs 1 --only u1-3,u1-4'
//   make eval EVAL=--dry            builds every prompt and calls no model

import '../src/mastra/telemetry.ts'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Agent } from '@mastra/core/agent'
import { readConfig } from '../src/hdtp/config.ts'
import { NodeRefusal, type JsonSchema } from '../src/hdtp/node.ts'
import { FIRST_TURNS } from '../src/hdtp/responder.ts'
import { drafter } from '../src/hdtp/runtime.ts'
import { Turns, type Turn } from '../src/hdtp/turn.ts'
import { instructions } from '../src/mastra/agents/delegate.ts'
import { OWNERS, PERSONAS, passes, plan, promptFor, type Persona } from './points.ts'

const { values } = parseArgs({
  options: { runs: { type: 'string', default: '5' }, only: { type: 'string' }, dry: { type: 'boolean', default: false } },
})
const points = plan(Number(values.runs), values.only?.split(','))
const runs = Number(values.runs)

const tools = JSON.parse(readFileSync(new URL('../test/owner-mcp-tools.json', import.meta.url), 'utf8')) as Array<{ name: string; inputSchema: JsonSchema }>
const turns = new Turns({
  toolSchema: async (name) => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`no ${name} in test/owner-mcp-tools.json`)
    return tool.inputSchema
  },
})
const schema = await turns.schema()
const prompts = new Map(points.map((p) => [p.id, promptFor(p, schema)]))
if (values.dry) {
  process.stderr.write(`dry: ${points.length} points x ${runs} runs = ${points.length * runs} calls, prompts ${[...prompts.values()].map((p) => p.length).join(' ')} chars\n`)
  process.exit(0)
}

const model = readConfig().model
const agents = new Map<Persona, Agent>()
const agentFor = (persona: Persona) => {
  let agent = agents.get(persona)
  if (!agent) {
    agent = new Agent({ id: `eval-${persona}`, name: `eval-${persona}`, instructions: instructions(PERSONAS[persona]), model })
    agents.set(persona, agent)
  }
  return agent
}

const tally = new Map(points.map((p) => [p.id, { passed: 0, valid: 0, types: [] as string[] }]))
for (let run = 1; run <= runs; run++) {
  for (const point of points) {
    const agent = agentFor(point.persona)
    let usage: unknown
    let finish: unknown
    // The drafter as the runtime builds it, over the agent; the wrapper only keeps what it answered.
    const generate = agent.generate.bind(agent) as (...args: unknown[]) => Promise<{ usage: unknown; finishReason: unknown }>
    const draft = drafter({
      generate: (async (...args: unknown[]) => {
        const out = await generate(...args)
        usage = out.usage
        finish = out.finishReason
        return out
      }) as unknown as Agent['generate'],
    })
    const t0 = Date.now()
    let text: string | null = null
    let turn: Turn | null = null
    let refusal: string | null = null
    try {
      text = await draft(prompts.get(point.id)!)
      turn = await turns.read(text, FIRST_TURNS, OWNERS[point.persona])
    } catch (e) {
      refusal = e instanceof NodeRefusal ? `${e.tool}:${e.code}` : 'model_failed'
    }
    let type: string | null = turn?.type ?? null
    if (!turn && text) {
      try {
        type = (JSON.parse(text) as { type?: string }).type ?? null
      } catch {
        type = null
      }
    }
    const pass = turn !== null && passes(point, turn)
    const t = tally.get(point.id)!
    if (pass) t.passed++
    if (turn) t.valid++
    t.types.push(turn?.type === 'notify' && turn.reply !== undefined ? 'notify+reply' : (type ?? '-'))
    process.stdout.write(
      `${JSON.stringify({ point: point.id, run, persona: point.persona, expected: point.expected, type, pass, valid: turn !== null, refusal, finish, ms: Date.now() - t0, model, usage, turn, text: turn ? undefined : text })}\n`,
    )
  }
}

let below = 0
for (const point of points) {
  const t = tally.get(point.id)!
  if (t.passed * 5 < runs * 4) below++
  process.stderr.write(`${point.id.padEnd(5)} ${point.title.padEnd(38)} type ${t.passed}/${runs}  valid ${t.valid}/${runs}  [${t.types.join(' ')}]\n`)
}
process.stderr.write(`${below} of ${points.length} points below 4 in 5\n`)
