// The delegate: drafts a reply in the owner's voice and does nothing else. It is given no tools;
// reading the thread and sending the reply are done by code (src/hdtp/responder.ts).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Agent } from '@mastra/core/agent'
import { readConfig } from '../../hdtp/config.ts'
import { FRAME } from '../../hdtp/prompt.ts'

const config = readConfig()

/**
 * The fixed frame, then the owner's persona. Read once at start, so Studio shows it; restart after
 * an edit. A relative path is taken from where the agent was started: npm and npx record that as
 * INIT_CWD, and `mastra dev` runs the server from src/mastra/public, not from there.
 */
export function instructions(personaFile = config.personaFile): string {
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), personaFile)
  return `${FRAME}\n\n${readFileSync(path, 'utf8').trim()}`
}

export const delegate = new Agent({
  id: 'delegate',
  name: 'Delegate',
  description: "Drafts replies to an HDTP node's contacts on behalf of its owner",
  instructions: instructions(),
  model: config.model,
})
