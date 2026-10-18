// The agent's settings, from the environment. `.env.example` lists each one.

export const DEFAULT_MODEL = 'openai/gpt-6-luna'
/** The node's internal listener (InternalBind, 127.0.0.1:8080) and its owner MCP mount. */
export const DEFAULT_OWNER_MCP_URL = 'http://127.0.0.1:8080/owner/mcp'
export const DEFAULT_RECONCILE_SECONDS = 60
export const DEFAULT_PERSONA_FILE = 'persona.md'

export interface Config {
  model: string
  ownerMcpUrl: string
  ownerToken: string | undefined
  webhookSecret: string | undefined
  reconcileSeconds: number
  personaFile: string
}

const set = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim())

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const seconds = Number(set(env.HDTP_RECONCILE_SECONDS) ?? DEFAULT_RECONCILE_SECONDS)
  return {
    model: set(env.HDTP_AGENT_MODEL) ?? DEFAULT_MODEL,
    ownerMcpUrl: set(env.HDTP_OWNER_MCP_URL) ?? DEFAULT_OWNER_MCP_URL,
    ownerToken: set(env.HDTP_OWNER_TOKEN),
    webhookSecret: set(env.HDTP_WEBHOOK_SECRET),
    reconcileSeconds: Number.isInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RECONCILE_SECONDS,
    personaFile: set(env.HDTP_PERSONA_FILE) ?? DEFAULT_PERSONA_FILE,
  }
}
