// The node's owner MCP, called by code. Its tools are never handed to the model.
//
// Names and shapes are the node's (hdtp-gateway internal/internalui/ownermcp/server.go):
// arguments in snake_case; get_inbox and read_thread rows in snake_case; list_pending rows and
// send_to_contact's result in Go's field names, which carry no json tags. A refusal is a tool
// error whose text is {"code", "detail"}; only the code is kept.

import type { ToolExecutionContext } from '@mastra/core/tools'
import { MCPClient } from '@mastra/mcp'

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
  direction: string // "in" from the contact, "out" from this side
  sender: string
  kind: string
  body: string
  trust: string
  created_at: number
}

/** One row of list_pending. */
export interface PendingRequest {
  ID: string
  ContactFpr: string
  Capability: string
  Args: string // the caller's arguments, untrusted
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

/** The tools of the owner MCP this agent uses, and nothing else. */
export interface NodeClient {
  listAccounts(): Promise<string[]>
  getInbox(accountId: string): Promise<InboxThread[]>
  readThread(accountId: string, threadId: string): Promise<ThreadMessage[]>
  sendToContact(args: SendArgs): Promise<void>
  listPending(accountId: string): Promise<PendingRequest[]>
  answerRequest(args: AnswerArgs): Promise<void>
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

type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>

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

/** A NodeClient over any way of calling a tool by name. */
export function nodeClientOver(call: CallTool): NodeClient {
  const json = async (tool: string, args: Record<string, unknown>) => decodeAnswer(tool, await call(tool, args))
  return {
    async listAccounts() {
      return ((await json('list_accounts', {})) as string[] | null) ?? []
    },
    async getInbox(accountId) {
      return ((await json('get_inbox', { account_id: accountId })) as InboxThread[] | null) ?? []
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
  }
}

/** The MCP client for the node's owner MCP under a bearer token, and the NodeClient over it. */
export function connectNode(url: string, token: string): { node: NodeClient; disconnect: () => Promise<void> } {
  const mcp = new MCPClient({
    id: 'hdtp-owner-mcp',
    servers: {
      hdtp: {
        url: new URL(url),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        onToolError: 'return',
        enableServerLogs: false,
      },
    },
  })
  type Tools = Awaited<ReturnType<MCPClient['listToolsetsWithErrors']>>['toolsets'][string]
  // Listed once and kept; listed again after any failure. A node that refused the token or could
  // not be reached is named as such, not as a missing tool.
  let tools: Promise<Tools> | null = null
  const list = async (): Promise<Tools> => {
    const { toolsets, errors, errorDetails } = await mcp.listToolsetsWithErrors()
    const failed = errorDetails.hdtp
    if (failed || errors.hdtp !== undefined) {
      throw new NodeRefusal('connect', failed?.httpStatus === 401 ? 'owner_token_refused' : 'node_unreachable')
    }
    return toolsets.hdtp ?? {}
  }
  const call: CallTool = async (name, args) => {
    try {
      const set = await (tools ??= list())
      const tool = set[name]
      if (!tool?.execute) throw new NodeRefusal(name, 'tool_not_offered')
      // Called by code, outside any agent run: the MCP tool reads only the context's optional members.
      return (await tool.execute(args, {} as ToolExecutionContext)) as ToolAnswer
    } catch (e) {
      tools = null
      throw e instanceof NodeRefusal ? e : new NodeRefusal(name, 'node_unreachable')
    }
  }
  return { node: nodeClientOver(call), disconnect: () => mcp.disconnect() }
}
