// What the model returns for a thread: one turn, as one JSON object, which code checks and carries out.
//
//   reply   text for the contact, sent with send_to_contact
//   ask     a surface for the owner, put with ask_owner; nothing goes to the contact until they act
//   notify  a surface for the owner with no buttons, put with notify_owner, after an optional reply
//   none    nothing is sent
//
// The schema is built from the node's own input schemas, read from its tools/list when the agent
// first needs it: send_to_contact's `text` for a reply, and ask_owner's and notify_owner's
// arguments, less the ids code fills, for the two surfaces. The component catalog is therefore the
// node's alone; nothing here names a component. A rule the node checks and its schema does not
// state is met by the node's refusal, which fails the attempt as a turn that does not parse does.

import { toStandardSchema } from '@mastra/core/schema'
import { NodeRefusal, type JsonSchema, type NodeClient } from './node.ts'

/**
 * The dialect of every tool input schema: MCP's default, which @mastra/mcp also names on each schema
 * it reads. The turn schema is checked in it; a validator left to its own default would pass over
 * the 2020-12 keywords the node uses (prefixItems, for a surface's two messages) unchecked.
 */
export const DIALECT = 'https://json-schema.org/draft/2020-12/schema'

/** The arguments of ask_owner and notify_owner that code fills, never the model. */
export const FILLED_BY_CODE = ['account_id', 'thread_id', 'for_message_id'] as const

export type TurnType = 'reply' | 'ask' | 'notify' | 'none'

export type Turn =
  | { type: 'reply'; text: string }
  | { type: 'ask'; ask: Record<string, unknown> }
  | { type: 'notify'; notice: Record<string, unknown>; reply?: string }
  | { type: 'none' }

/** A tool's schema with the arguments code fills taken out; its $defs are hoisted by the caller. */
function surfaceOf(tool: string, schema: JsonSchema): JsonSchema {
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) }
  for (const k of FILLED_BY_CODE) {
    if (!(k in properties)) throw new NodeRefusal(tool, 'schema_unexpected')
    delete properties[k]
  }
  const required = ((schema.required as string[] | undefined) ?? []).filter((k) => !(FILLED_BY_CODE as readonly string[]).includes(k))
  const { $schema: _dialect, $defs: _defs, definitions: _definitions, properties: _p, required: _r, ...rest } = schema
  return { ...rest, properties, required }
}

/** The $defs of the schemas, merged; one name defined two different ways is refused. */
function hoist(schemas: Array<[string, JsonSchema]>): Record<string, unknown> {
  const defs: Record<string, unknown> = {}
  for (const [tool, schema] of schemas) {
    if (schema.definitions !== undefined) throw new NodeRefusal(tool, 'schema_unexpected')
    for (const [name, def] of Object.entries((schema.$defs as Record<string, unknown> | undefined) ?? {})) {
      if (name in defs && JSON.stringify(defs[name]) !== JSON.stringify(def)) throw new NodeRefusal(tool, 'schema_unexpected')
      defs[name] = def
    }
  }
  return defs
}

/** The turn schema, from the node's input schemas of send_to_contact, ask_owner and notify_owner. */
export function turnSchema(send: JsonSchema, ask: JsonSchema, notify: JsonSchema): JsonSchema {
  for (const [tool, schema] of [
    ['send_to_contact', send],
    ['ask_owner', ask],
    ['notify_owner', notify],
  ] as const) {
    if (schema.$schema !== undefined && schema.$schema !== DIALECT) throw new NodeRefusal(tool, 'schema_unexpected')
  }
  const text = (send.properties as Record<string, JsonSchema> | undefined)?.text
  if (!text) throw new NodeRefusal('send_to_contact', 'schema_unexpected')
  const defs = hoist([
    ['ask_owner', ask],
    ['notify_owner', notify],
  ])
  const branch = (type: TurnType, properties: Record<string, unknown> = {}, required: string[] = []) => ({
    type: 'object',
    properties: { type: { const: type }, ...properties },
    required: ['type', ...required],
    additionalProperties: false,
  })
  return {
    $schema: DIALECT,
    ...(Object.keys(defs).length ? { $defs: defs } : {}),
    oneOf: [
      branch('reply', { text }, ['text']),
      branch('ask', { ask: surfaceOf('ask_owner', ask) }, ['ask']),
      branch('notify', { notice: surfaceOf('notify_owner', notify), reply: text }, ['notice']),
      branch('none'),
    ],
  }
}

/** The turn in a model's answer: the JSON object, bare or in one fenced block. */
function parse(answer: string): unknown {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(answer.trim())
  try {
    return JSON.parse(fenced ? fenced[1]! : answer)
  } catch {
    throw new NodeRefusal('draft', 'invalid_turn')
  }
}

/**
 * A value with every object property that is null left out, at any depth; nulls inside arrays
 * stay. A model in strict mode writes null for an optional field it leaves empty, and the node
 * refuses a null where its schema says a string.
 */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (v === null ? [] : [[k, withoutNulls(v)]])))
}

/**
 * The texts an ask would send to the contact as the owner's own message, as the node's ask_owner
 * says: each ready reply Button's context.reply (an event named "reply"), and each option label of
 * a ChoicePicker. Found by those shapes at any depth, so no component's place is assumed.
 */
export function readyReplies(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(readyReplies)
  if (value === null || typeof value !== 'object') return []
  const o = value as Record<string, unknown>
  const own: string[] = []
  const context = o.context as Record<string, unknown> | undefined
  if (o.name === 'reply' && typeof context?.reply === 'string') own.push(context.reply)
  if (o.component === 'ChoicePicker' && Array.isArray(o.options)) {
    for (const option of o.options as Array<Record<string, unknown>>) if (typeof option?.label === 'string') own.push(option.label)
  }
  return [...own, ...Object.values(o).flatMap(readyReplies)]
}

/**
 * Whether `text` names `owner`: their first name or their whole name, as whole words in any case;
 * never for no name. The other words of a name are left out, since a surname can be a common word
 * ("Will", "Dental") that a first-person reply holds for its own sake.
 */
export function names(text: string, owner: string): boolean {
  const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const name = words(owner)
  if (name.length === 0) return false
  const said = ` ${words(text).join(' ')} `
  return said.includes(` ${name[0]} `) || said.includes(` ${name.join(' ')} `)
}

/** Reads turns against the node's schema, which is read once and kept. */
export class Turns {
  private readonly node: Pick<NodeClient, 'toolSchema'>
  private built: Promise<{ schema: JsonSchema; check: ReturnType<typeof toStandardSchema> }> | null = null

  constructor(node: Pick<NodeClient, 'toolSchema'>) {
    this.node = node
  }

  /** The turn schema; read from the node the first time, and again after a failure. */
  async schema(): Promise<JsonSchema> {
    return (await this.build()).schema
  }

  private build() {
    this.built ??= (async () => {
      const [send, ask, notify] = await Promise.all(['send_to_contact', 'ask_owner', 'notify_owner'].map((t) => this.node.toolSchema(t)))
      const schema = turnSchema(send!, ask!, notify!)
      return { schema, check: toStandardSchema(schema) }
    })()
    this.built.catch(() => (this.built = null))
    return this.built
  }

  /**
   * The turn in a model's answer, if it is one of `allowed`. Anything else is a refusal named draft:
   * invalid_turn for an answer that is not a turn of the schema, turn_not_allowed for one that is
   * and is not offered here. An answer the schema refuses is checked once more without its null
   * properties: a null on an optional field is read as the field left out, and a null on a required
   * one is still refused, as the field missing. Where the schema takes a null, the answer passes as
   * written. The validator's text is never kept. With `owner`, the person's display name, an ask
   * whose ready replies name them is refused (draft:reply_names_owner): a ready reply is their own
   * message, and one that names them speaks of them in the third person.
   */
  async read(answer: string, allowed: readonly TurnType[], owner = ''): Promise<Turn> {
    const { check } = await this.build()
    const value = parse(answer)
    let result = await check['~standard'].validate(value)
    if (result.issues) result = await check['~standard'].validate(withoutNulls(value))
    if (result.issues) throw new NodeRefusal('draft', 'invalid_turn')
    const turn = result.value as Turn
    if (!allowed.includes(turn.type)) throw new NodeRefusal('draft', 'turn_not_allowed')
    if ((turn.type === 'reply' && !turn.text.trim()) || (turn.type === 'notify' && turn.reply !== undefined && !turn.reply.trim())) {
      throw new NodeRefusal('draft', 'empty')
    }
    if (turn.type === 'ask' && readyReplies(turn.ask).some((text) => names(text, owner))) {
      throw new NodeRefusal('draft', 'reply_names_owner')
    }
    return turn
  }
}
