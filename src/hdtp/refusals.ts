// What the model is told on a retry: the code that refused its previous turn, and a fixed line of
// this agent's saying what the code means. The node's own text (a refusal's detail) is never kept
// (node.ts, decodeAnswer), so it never reaches a prompt; a code with no line here adds nothing.
//
// The surface rules are the node's (hdtp-gateway internal/services/asks/catalog.go, each refusal's
// Rule), each line written from the node's own refusal at the sha test/surface-rules.json records;
// that file lists the rules, and a test holds the keys below equal to it. A rule a newer node adds
// is still named to the model, with the line for a rule this agent does not know.

import { NodeRefusal } from './node.ts'

/** A previous turn's refusal, as the next prompt quotes it. */
export interface Refused {
  /** The refusal's code: draft:<code>, or the node's invalid_surface:<rule>. */
  refused: string
  /** What the code means, in this agent's words. */
  why: string
}

/** The agent's own checks of a turn (turn.ts, runtime.ts), by code. */
export const DRAFT_REFUSALS: Readonly<Record<string, string>> = {
  invalid_turn:
    "The answer was not one JSON object matching the turn's JSON Schema: check every required field, every const (such as version and catalogId) and every enum.",
  turn_not_allowed: "The turn's type was not one of the turns offered for this message.",
  empty: 'The answer, or the text of its reply, was empty.',
  truncated: 'The answer was cut off at its length limit: write a shorter turn.',
  reply_names_owner: 'A ready reply named the person: each ready reply is their own message, in the first person.',
}

/** The node's surface rules (ask_owner's and notify_owner's reason invalid_surface:<rule>), by rule. */
export const SURFACE_RULES: Readonly<Record<string, string>> = {
  surface_size: 'The surface was over the size the node takes: write a shorter one.',
  messages:
    'The surface had the wrong messages: an ask is createSurface, updateComponents and optionally updateDataModel; a notice is createSurface, then updateComponents.',
  catalog_id: 'createSurface names the catalog by the exact catalogId the schema gives.',
  surface_id: 'Every message names the surfaceId that createSurface made.',
  component_count: 'The surface held fewer than 2 components, or more than the node takes.',
  duplicate_id: 'A component id was used twice: each component has an id of its own.',
  version: 'Every message names the version the schema gives.',
  message_shape: 'Each message holds version and its one message (createSurface, updateComponents or updateDataModel), with that message\'s fields alone.',
  model_path: 'updateDataModel takes the whole data model: omit path, or give "/".',
  model_shape: 'The data model is an object.',
  model_depth: 'The data model nested deeper than the node takes.',
  component_shape: 'A component was not an object with an id and fields of the types its catalog entry gives.',
  unknown_component: 'A component was not one the catalog offers for this kind of surface.',
  unknown_prop: 'A component had a property its catalog entry does not have.',
  required_prop: 'A component lacked a property its catalog entry requires.',
  date_enables: 'A DateTimeInput enables a date, a time or both.',
  prop_value:
    "A property's value was not of the kind its catalog entry takes: an empty text, an id that is no component's, or a value outside its enum.",
  prop_size: 'A property was over its size: too long a text, or too many items.',
  option_values: 'Two options of a ChoicePicker had the same value.',
  action_shape: "A Button's action is {event: {name, context}}, and nothing else.",
  action_function: 'An action is an event, {event: {name, context}}: the portal runs no function.',
  reply_context: "A ready reply's event context is {reply}, the text one tap sends, and nothing else.",
  context_value: "An event's context is an object of a few keys, each a literal string, number or boolean, or a {path} in the data model.",
  binding: 'A binding is {path}, an absolute JSON Pointer, and nothing else.',
  root_missing: 'No component had id "root".',
  root_column: 'The root is a Column.',
  root_first: 'The root comes first in the list of components.',
  root_placed: "The root is placed under nothing: no component names it as a child.",
  child_missing: 'A child named an id no component has.',
  placed_twice:
    "A component was placed twice: each one is placed once, either as a child of root or as one Button's label, so a Button's label Text is not also a child of root.",
  column_not_root: 'Only the root is a Column.',
  button_label: "A Button's child is the Text that is its label.",
  binding_shared: 'Two inputs bound one place in the data model: each input binds a path of its own.',
  placed_nowhere: "A component was placed nowhere: each one is a child of root or a Button's label.",
  tldr_first_child: 'The first child of root is a Text, the TLDR.',
  tldr_second: "The TLDR, root's first child, comes second in the list of components, right after root.",
  tldr_size: 'The TLDR was over its size: one short line.',
  input_count: 'A surface has at most one ChoicePicker and one TextField.',
  reply_count: 'The surface had more ready replies than the node takes: one to three.',
  context_unbound: "An event's context read a {path} that no input binds.",
  own_message:
    "An ask ends with the person's own message: root's next-to-last child is the TextField, and its last the Button whose context reads the TextField's path.",
  model_value: 'The data model held a value that the input bound to its path could not have written.',
}

/** The line for a surface rule this agent has no line for. */
export const UNKNOWN_RULE = "The node's surface rule named by this code refused the surface: follow the surface's schema and its description."

const SURFACE = 'invalid_surface:'

/** A table's own line for a code: never one an object inherits, such as constructor. */
const lineOf = (lines: Readonly<Record<string, string>>, code: string) => (Object.hasOwn(lines, code) ? lines[code] : undefined)

/**
 * What the next attempt is told of a failed one: the draft's own refusals and the node's surface
 * rules, by code. Anything else (the model failing, a budget, a transport fault) is not a fault of
 * the turn, and adds nothing.
 */
export function refusedOf(e: unknown): Refused | null {
  if (!(e instanceof NodeRefusal)) return null
  if (e.reason.startsWith(SURFACE)) {
    return { refused: e.reason, why: lineOf(SURFACE_RULES, e.reason.slice(SURFACE.length)) ?? UNKNOWN_RULE }
  }
  const why = e.tool === 'draft' ? lineOf(DRAFT_REFUSALS, e.code) : undefined
  return why === undefined ? null : { refused: `draft:${e.code}`, why }
}
