// The agent's settings, from the environment. `.env.example` lists each one.

/** OpenAI's GPT-6 Luna through OpenRouter, a Mastra router string; Mastra reads OPENROUTER_API_KEY. */
export const DEFAULT_MODEL = 'openrouter/openai/gpt-6-luna'
/** The node's internal listener (InternalBind, 127.0.0.1:8080) and its owner MCP mount. */
export const DEFAULT_OWNER_MCP_URL = 'http://127.0.0.1:8080/owner/mcp'
export const DEFAULT_RECONCILE_SECONDS = 60
export const DEFAULT_PERSONA_FILE = 'persona.md'
/** How many agent-to-agent turns in a row a thread may have before the agent stops answering it. */
export const DEFAULT_AGENT_TURN_CAP = 3
/** How many drafts one contact may have in an hour, whatever the sender labels say. */
export const DEFAULT_REPLIES_PER_HOUR = 10
/** Where the agent keeps what it must remember across restarts: its first-start time. */
export const DEFAULT_DATA_DIR = 'data'

export interface Config {
  model: string
  ownerMcpUrl: string
  ownerToken: string | undefined
  webhookSecret: string | undefined
  reconcileSeconds: number
  personaFile: string
  agentTurnCap: number
  repliesPerHour: number
  dataDir: string
}

const set = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim())

/** A whole number above 0, or the default when the value is anything else. */
function count(v: string | undefined, fallback: number): number {
  const n = Number(set(v) ?? fallback)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    model: set(env.HDTP_AGENT_MODEL) ?? DEFAULT_MODEL,
    ownerMcpUrl: set(env.HDTP_OWNER_MCP_URL) ?? DEFAULT_OWNER_MCP_URL,
    ownerToken: set(env.HDTP_OWNER_TOKEN),
    webhookSecret: set(env.HDTP_WEBHOOK_SECRET),
    reconcileSeconds: count(env.HDTP_RECONCILE_SECONDS, DEFAULT_RECONCILE_SECONDS),
    personaFile: set(env.HDTP_PERSONA_FILE) ?? DEFAULT_PERSONA_FILE,
    agentTurnCap: count(env.HDTP_AGENT_TURN_CAP, DEFAULT_AGENT_TURN_CAP),
    repliesPerHour: count(env.HDTP_AGENT_REPLIES_PER_HOUR, DEFAULT_REPLIES_PER_HOUR),
    dataDir: set(env.HDTP_AGENT_DATA_DIR) ?? DEFAULT_DATA_DIR,
  }
}
