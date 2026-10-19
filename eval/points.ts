// The decision points the turn eval drafts for (eval/run.ts): the U1 meeting and the U5 dentist
// stories of examples/personas/, each point the thread as the deciding side's node would hand it
// over, and the turns that pass there. Hermetic: test/eval.test.ts builds every prompt with no model.

import type { JsonSchema, ThreadMessage } from '../src/hdtp/node.ts'
import { threadPrompt, type ThreadContext } from '../src/hdtp/prompt.ts'
import { FIRST_TURNS } from '../src/hdtp/responder.ts'
import type { Turn } from '../src/hdtp/turn.ts'

/** The most model calls one run of the eval makes: 10 points, 5 runs each. */
export const CEILING = 50

export type Persona = 'ana' | 'ben' | 'clinic' | 'patient'

export const PERSONAS: Record<Persona, string> = {
  ana: 'examples/personas/u1-meeting-ana.md',
  ben: 'examples/personas/u1-meeting-ben.md',
  clinic: 'examples/personas/u5-dentist-clinic.md',
  patient: 'examples/personas/u5-dentist-patient.md',
}

/** What a turn must be to pass at a point. */
export type Expect = 'reply' | 'ask' | 'none' | 'notify' | 'notify+reply'

export interface Point {
  id: string
  title: string
  persona: Persona
  /** The turns that pass, any one of them. */
  expected: readonly Expect[]
  messages: ThreadMessage[]
  context: ThreadContext
}

type Line = [side: Persona, sender: 'human' | 'agent', body: string]

const MEETING: Line[] = [
  ['ben', 'human', 'Hi Ana, can we meet this week about the project?'],
  ['ana', 'agent', "Hi Ben, this is Ana's agent. Ana could do Wednesday at 10:00 for 30 minutes, budget first and then the timeline. Would that work?"],
  ['ben', 'agent', "Thanks! This is Ben's agent. Ben is free only in the afternoons: could we do Wednesday at 15:00 instead, 30 minutes, budget first and then the timeline?"],
  // The ready reply Ana chose on her agent's ask, sent by her node as her own message.
  ['ana', 'human', 'Yes, Wednesday at 15:00 works for me: 30 minutes, budget first, then the timeline.'],
  ['ben', 'agent', "Great, that's confirmed for Ben: Wednesday at 15:00, 30 minutes, budget first and then the timeline. See you then!"],
  ['ana', 'human', 'Thanks!'],
]

const DENTIST: Line[] = [
  ['patient', 'agent', "Hi, this is Jo's agent. Jo would like a dental check-up. Which times do you have open?"],
  ['clinic', 'agent', 'Hello! For a check-up we have Tuesday at 10:00, Wednesday at 14:00 or Thursday at 16:00, 45 minutes each. Which would suit Jo?'],
  ['patient', 'agent', 'Tuesday at 10:00 suits Jo. Please book it.'],
  ['clinic', 'agent', "Booked: Jo's check-up is on Tuesday at 10:00, for 45 minutes. See you then!"],
]

/** The first `n` lines of a story as `me`'s node lists them: its own lines out, the other side's in. */
function seen(story: Line[], me: Persona, n: number): ThreadMessage[] {
  return story.slice(0, n).map(([side, sender, body], i) => ({
    message_id: `m${i + 1}`,
    direction: side === me ? 'out' : 'in',
    sender,
    kind: 'text',
    body,
    trust: 'may_instruct',
    created_at: 1_792_400_000 + i * 60,
  }))
}

/** What Ana's node records as her answer to her agent's ask on Ben's counter: the reply she chose. */
const ANAS_ANSWER = `Ana chose: "${MEETING[3]![2]}"`

export const POINTS: Point[] = [
  { id: 'u1-1', title: 'Ana on "meet this week?"', persona: 'ana', expected: ['reply'], messages: seen(MEETING, 'ana', 1), context: {} },
  { id: 'u1-2', title: 'Ben on the proposal', persona: 'ben', expected: ['reply'], messages: seen(MEETING, 'ben', 2), context: {} },
  { id: 'u1-3', title: 'Ana on the counter', persona: 'ana', expected: ['ask'], messages: seen(MEETING, 'ana', 3), context: {} },
  // Ana accepted Ben's counter: Ben's side confirms, and he lets his agent commit to such a meeting.
  { id: 'u1-4', title: "Ben on Ana's yes", persona: 'ben', expected: ['notify+reply', 'reply'], messages: seen(MEETING, 'ben', 4), context: {} },
  // Ana said yes herself: nothing more to send, and nothing to tell her.
  {
    id: 'u1-5',
    title: "Ana on Ben's confirm",
    persona: 'ana',
    expected: ['none'],
    messages: seen(MEETING, 'ana', 5),
    context: { decisions: [ANAS_ANSWER] },
  },
  {
    id: 'u1-6',
    title: 'Ben on "Thanks!"',
    persona: 'ben',
    expected: ['none'],
    messages: seen(MEETING, 'ben', 6),
    context: { notices: ['Meeting with Ana confirmed: Wed 15:00, 30 min'] },
  },
  { id: 'u5-1', title: "Clinic on the patient's request", persona: 'clinic', expected: ['reply'], messages: seen(DENTIST, 'clinic', 1), context: {} },
  // A confirmation is still to come from the clinic, so no notice yet.
  { id: 'u5-2', title: 'Patient on the offered slots', persona: 'patient', expected: ['reply'], messages: seen(DENTIST, 'patient', 2), context: {} },
  { id: 'u5-3', title: 'Clinic on the booking', persona: 'clinic', expected: ['notify+reply'], messages: seen(DENTIST, 'clinic', 3), context: {} },
  { id: 'u5-4', title: "Patient on the clinic's confirmation", persona: 'patient', expected: ['notify', 'notify+reply'], messages: seen(DENTIST, 'patient', 4), context: {} },
]

/** The prompt the responder would write for the point: the first turn on its newest message. */
export function promptFor(point: Point, schema: JsonSchema): string {
  return threadPrompt(point.messages, schema, FIRST_TURNS, point.context)
}

/** Whether a turn passes at a point. */
export function passes(point: Point, turn: Turn): boolean {
  const as: Expect = turn.type === 'notify' && turn.reply !== undefined ? 'notify+reply' : turn.type
  return point.expected.includes(as)
}

/** The points a run drafts for, `runs` times each; refused above the ceiling. */
export function plan(runs: number, only?: readonly string[]): Point[] {
  const points = only?.length ? POINTS.filter((p) => only.includes(p.id)) : POINTS
  if (only?.length && points.length !== only.length) throw new Error(`unknown point in ${only.join(',')}`)
  if (!Number.isInteger(runs) || runs < 1 || points.length * runs > CEILING) throw new Error(`${points.length} points x ${runs} runs is over ${CEILING} calls`)
  return points
}
