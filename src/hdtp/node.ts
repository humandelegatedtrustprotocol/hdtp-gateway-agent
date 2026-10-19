// The node's owner MCP, called by code. Its tools are never handed to the model.
//
// Names and shapes are the node's (hdtp-gateway internal/internalui/ownermcp/server.go):
// arguments in snake_case; get_inbox, read_thread and list_contacts rows in snake_case; list_pending rows and
// send_to_contact's result in Go's field names, which carry no json tags. A refusal is a tool
// error whose text is {"code", "detail"}; only the code is kept.

import { standardSchemaToJSONSchema } from '@mastra/core/schema'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { MCPClient, type LogMessage } from '@mastra/mcp'

/** One row of get_inbox. */
export interface InboxThread {
  thread_id: string
  contact_fpr: string
  unread: number
  last_at: number
  contact_status: string
}

/** One message of read_thread, oldest first. */
export interface ThreadMessage {
  /** The message's msg_id on the node, unique per account, contact and direction. */
  message_id: string
  direction: string // "in" from the contact, "out" from this side
  sender: string
  kind: string
  body: string
  trust: string
  created_at: number
}

/** One row of list_contacts, the fields this agent reads. */
export interface Contact {
  fingerprint: string
  status: string
  /** The owner's stance on the contact: messages_only (the node's default) or may_instruct. */
  trust_flag: string
}

/** One row of list_pending. */
export interface PendingRequest {
  ID: string
  ContactFpr: string
  Capability: string
  Args: string // the caller's arguments, untrusted
  /** The contact's trust flag, as list_contacts names it trust_flag. */
  TrustFlag: string
  Status: string
  ExpiresAt: number
}

export interface SendArgs {
  account_id: string
  contact_fpr: string
  thread_id: string
  msg_id: string
  text: string
}

export interface AnswerArgs {
  account_id: string
  request_id: string
  result: string
}

/** A tool's input schema, as the node lists it in tools/list. */
export type JsonSchema = Record<string, unknown>

/**
 * One ask or notice on the node, the fields this agent reads (list_asks rows, the asks service's
 * View). An ask is open until the owner answers it, the agent withdraws it, or it expires.
 */
export interface OwnerAsk {
  id: string
  kind: string // ask or notice
  thread_id: string
  /** The contact's message the ask or notice was raised for. */
  for_message_id: string
  status: string // open, answered, withdrawn, expired; posted for a notice
  /** The owner's answer as one line of text; empty until answered. */
  answer_text: string
}

/** Which asks list_asks lists: the account's open asks, or every ask and notice with one contact. */
export type AsksOf = { open: true } | { contactFpr: string }

/** ask_owner's and notify_owner's arguments: the ids code fills, and the surface the model wrote. */
export type SurfaceArgs = Record<string, unknown> & { account_id: string; thread_id: string; for_message_id: string }

/**
 * One answer of wait_for_updates, the fields this agent reads (ownermcp watch.go, waitResult).
 * The node holds the call until something moves for the account or up to 25 s, then answers.
 */
export interface WaitAnswer {
  /** Where the next wait starts: the newest change the answer read, even when nothing moved. */
  cursor: number
  /** The cursor was not one the change log can answer from; what moved before it is not listed. */
  cursor_expired?: boolean
  /** Threads that moved since the cursor; null when none did. */
  threads: Array<{ thread_id: string }> | null
  /** Agent-answered calls waiting for an answer, a standing total reported on every answer. */
  pending_requests: number
  /** The wait ended on the clock rather than on an event. */
  timed_out: boolean
}

/** Every tool of the owner MCP this agent calls. The runtime answers nothing until the node lists them all. */
export const TOOLS_CALLED = [
  'list_accounts',
  'get_inbox',
  'list_contacts',
  'read_thread',
  'send_to_contact',
  'list_pending',
  'answer_request',
  'wait_for_updates',
  'ask_owner',
  'notify_owner',
  'list_asks',
] as const

/**
 * The node's tools as this client can call them: those offered, and those the node listed and the
 * client skipped for its input schema, each with the fault's code (schema_too_deep, schema_too_large,
 * schema_invalid).
 */
export interface ToolListing {
  offered: string[]
  skipped: Record<string, string>
}

/** The tools of the owner MCP this agent uses, and nothing else. */
export interface NodeClient {
  listAccounts(): Promise<string[]>
  getInbox(accountId: string): Promise<InboxThread[]>
  listContacts(accountId: string): Promise<Contact[]>
  readThread(accountId: string, threadId: string): Promise<ThreadMessage[]>
  sendToContact(args: SendArgs): Promise<void>
  listPending(accountId: string): Promise<PendingRequest[]>
  answerRequest(args: AnswerArgs): Promise<void>
  /** Omitting `since` starts from now: the node answers at once with a cursor and no backlog. */
  waitForUpdates(accountId: string, since: number | undefined, signal?: AbortSignal): Promise<WaitAnswer>
  /** An ask for the owner, idempotent on for_message_id. */
  askOwner(args: SurfaceArgs): Promise<void>
  /** A notice for the owner, idempotent on for_message_id. */
  notifyOwner(args: SurfaceArgs): Promise<void>
  /** The account's open asks, newest first, or one contact's asks and notices, oldest first. */
  listAsks(accountId: string, of: AsksOf): Promise<OwnerAsk[]>
  /** A tool's input schema as the node lists it; tool_not_offered for a tool it does not list. */
  toolSchema(name: string): Promise<JsonSchema>
  /** The node's tools/list, as this client took it. */
  listTools(): Promise<ToolListing>
}

/** A tool error from the node, by its code. */
export class NodeRefusal extends Error {
  readonly tool: string
  readonly code: string
  /** send_to_contact only: the message was recorded, and the node goes on delivering it. */
  readonly recorded: boolean
  constructor(tool: string, code: string, recorded = false) {
    super(`${tool}: ${code}`)
    this.tool = tool
    this.code = code
    this.recorded = recorded
  }
}

/** What to log for a failure: the refusal's tool and code, never an error's text. */
export function refusalCode(e: unknown): string {
  return e instanceof NodeRefusal ? `${e.tool}:${e.code}` : 'unexpected'
}

/** A tool's answer, as @mastra/mcp hands back a CallToolResult with onToolError 'return'. */
interface ToolAnswer {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

type CallTool = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolAnswer>

/** The JSON a tool answered with, or a NodeRefusal for a tool error. */
export function decodeAnswer(tool: string, answer: ToolAnswer): unknown {
  const text = answer.content?.find((c) => c.type === 'text')?.text
  let value: unknown = null
  try {
    value = text === undefined ? null : JSON.parse(text)
  } catch {
    throw new NodeRefusal(tool, 'unreadable_answer')
  }
  if (answer.isError) {
    const v = value as { code?: unknown; ThreadID?: unknown } | null
    const recorded = typeof v?.ThreadID === 'string' && v.ThreadID !== ''
    throw new NodeRefusal(tool, typeof v?.code === 'string' ? v.code : 'tool_error', recorded)
  }
  return value
}

/** What the node lists: a tool's input schema, and the listing itself. */
export interface Catalog {
  toolSchema(name: string): Promise<JsonSchema>
  listTools(): Promise<ToolListing>
}

/** A NodeClient over any way of calling a tool by name and of reading the node's tool list. */
export function nodeClientOver(call: CallTool, catalog: Catalog): NodeClient {
  const json = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    decodeAnswer(tool, await call(tool, args, signal))
  return {
    async listAccounts() {
      return ((await json('list_accounts', {})) as string[] | null) ?? []
    },
    async getInbox(accountId) {
      return ((await json('get_inbox', { account_id: accountId })) as InboxThread[] | null) ?? []
    },
    async listContacts(accountId) {
      return ((await json('list_contacts', { account_id: accountId })) as Contact[] | null) ?? []
    },
    async readThread(accountId, threadId) {
      return ((await json('read_thread', { account_id: accountId, thread_id: threadId })) as ThreadMessage[] | null) ?? []
    },
    async sendToContact(args) {
      try {
        await json('send_to_contact', { ...args })
      } catch (e) {
        // Recorded and not yet delivered (the error carries ThreadID and Status pending): the node
        // goes on delivering it under this msg_id, so the reply exists.
        if (e instanceof NodeRefusal && e.recorded) return
        throw e
      }
    },
    async listPending(accountId) {
      return ((await json('list_pending', { account_id: accountId })) as PendingRequest[] | null) ?? []
    },
    async answerRequest(args) {
      await json('answer_request', { ...args })
    },
    async waitForUpdates(accountId, since, signal) {
      const args = since === undefined ? { account_id: accountId } : { account_id: accountId, since }
      const answer = (await json('wait_for_updates', args, signal)) as Partial<WaitAnswer> | null
      // The loop takes its next cursor from this answer: one it cannot read is a failed wait, not a
      // start from nothing.
      if (
        typeof answer?.cursor !== 'number' ||
        !Number.isInteger(answer.cursor) ||
        answer.cursor < 0 ||
        typeof answer.pending_requests !== 'number' ||
        !(answer.threads === null || Array.isArray(answer.threads))
      ) {
        throw new NodeRefusal('wait_for_updates', 'unreadable_answer')
      }
      return answer as WaitAnswer
    },
    async askOwner(args) {
      await json('ask_owner', { ...args })
    },
    async notifyOwner(args) {
      await json('notify_owner', { ...args })
    },
    async listAsks(accountId, of) {
      const args = 'open' in of ? { account_id: accountId, status: 'open' } : { account_id: accountId, contact_fpr: of.contactFpr }
      const answer = (await json('list_asks', args)) as { asks?: unknown } | null
      if (!Array.isArray(answer?.asks)) throw new NodeRefusal('list_asks', 'unreadable_answer')
      return answer.asks as OwnerAsk[]
    },
    toolSchema: (name) => catalog.toolSchema(name),
    listTools: () => catalog.listTools(),
  }
}

/**
 * The code for a tool @mastra/mcp skipped while listing, read from its log line: the warning that
 * names the tool and its input schema's fault. Null for any other line.
 */
export function skippedTool(m: Pick<LogMessage, 'level' | 'details'>): { tool: string; code: string } | null {
  const d = m.details ?? {}
  if (m.level === 'warning' && typeof d.toolName === 'string' && typeof d.reason === 'string') {
    const code = d.reason.includes('maximum depth')
      ? 'schema_too_deep'
      : d.reason.includes('maximum node count')
        ? 'schema_too_large'
        : 'schema_invalid'
    return { tool: d.toolName, code }
  }
  return null
}

/** The MCP client for the node's owner MCP under a bearer token, and the NodeClient over it. */
export function connectNode(url: string, token: string): { node: NodeClient; disconnect: () => Promise<void> } {
  // The client skips a listed tool it cannot use and says so only in a log line; the reason is kept
  // here as a code, by tool, for the listing that was being read.
  let skipped: Record<string, string> = {}
  const mcp = new MCPClient({
    id: 'hdtp-owner-mcp',
    servers: {
      hdtp: {
        url: new URL(url),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        onToolError: 'return',
        enableServerLogs: false,
        logger: (m) => {
          const s = skippedTool(m)
          if (s) skipped[s.tool] = s.code
        },
      },
    },
  })
  type Tools = Awaited<ReturnType<MCPClient['listToolsetsWithErrors']>>['toolsets'][string]
  // Listed once and kept; listed again after any failure. A node that refused the token or could
  // not be reached is named as such, not as a missing tool.
  let tools: Promise<{ tools: Tools; skipped: Record<string, string> }> | null = null
  const list = async () => {
    skipped = {}
    const { toolsets, errors, errorDetails } = await mcp.listToolsetsWithErrors()
    const failed = errorDetails.hdtp
    if (failed || errors.hdtp !== undefined) {
      throw new NodeRefusal('connect', failed?.httpStatus === 401 ? 'owner_token_refused' : 'node_unreachable')
    }
    return { tools: toolsets.hdtp ?? {}, skipped }
  }
  const listed = () => {
    const p = (tools ??= list())
    p.catch(() => (tools = null))
    return p
  }
  const offered = async (name: string) => {
    try {
      const tool = (await listed()).tools[name]
      if (!tool?.execute) throw new NodeRefusal(name, 'tool_not_offered')
      return tool
    } catch (e) {
      tools = null
      throw e instanceof NodeRefusal ? e : new NodeRefusal(name, 'node_unreachable')
    }
  }
  const catalog: Catalog = {
    async toolSchema(name) {
      const tool = await offered(name)
      // The client keeps the listed JSON Schema behind a standard schema; this reads it back.
      return standardSchemaToJSONSchema(tool.inputSchema as Parameters<typeof standardSchemaToJSONSchema>[0]) as JsonSchema
    },
    async listTools() {
      const { tools, skipped } = await listed()
      return { offered: Object.keys(tools).filter((n) => tools[n]?.execute), skipped: { ...skipped } }
    },
  }
  const call: CallTool = async (name, args, signal) => {
    const tool = await offered(name)
    try {
      // Called by code, outside any agent run: the MCP tool reads only the context's optional members,
      // and hands abortSignal to the request, so stopping a held wait ends it.
      return (await tool.execute!(args, { abortSignal: signal } as ToolExecutionContext)) as ToolAnswer
    } catch (e) {
      tools = null
      throw e instanceof NodeRefusal ? e : new NodeRefusal(name, 'node_unreachable')
    }
  }
  return { node: nodeClientOver(call, catalog), disconnect: () => mcp.disconnect() }
}
