// The image's files, held to each other and to the code with no Docker: what compose.agent.yaml sets
// over agent.env is what the Dockerfile sets, the forwarder listens where the agent dials, and the
// build context admits every file the Dockerfile copies. Their run beside a real node was observed
// (see the pull request).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OWNER_MCP_URL } from '../src/hdtp/config.ts'

const dockerfile = readFileSync('Dockerfile', 'utf8')
const compose = readFileSync('compose.agent.yaml', 'utf8')
const makefile = readFileSync('Makefile', 'utf8')

/** The value the Dockerfile's ENV gives `name`. */
const imageEnv = (name: string) => dockerfile.match(new RegExp(`^\\s*(?:ENV\\s+)?${name}=(\\S+?)(?:\\s*\\\\)?$`, 'm'))?.[1]
/** The value compose.agent.yaml's `environment:` gives `name`. */
const composeEnv = (name: string) => compose.match(new RegExp(`^\\s+${name}: (\\S+)$`, 'm'))?.[1]

describe('the image and compose.agent.yaml', () => {
  it('set the same data directory and persona path', () => {
    for (const name of ['HDTP_AGENT_DATA_DIR', 'HDTP_PERSONA_FILE']) {
      expect(imageEnv(name), name).toBeDefined()
      expect(composeEnv(name), name).toBe(imageEnv(name))
    }
    expect(compose).toContain(`- agent-data:${imageEnv('HDTP_AGENT_DATA_DIR')}\n`)
    expect(compose).toContain(`target: ${imageEnv('HDTP_PERSONA_FILE')}\n`)
  })

  it('give the agent the owner MCP at the address its forwarder listens on', () => {
    expect(composeEnv('HDTP_OWNER_MCP_URL')).toBe(DEFAULT_OWNER_MCP_URL)
    const { hostname, port } = new URL(DEFAULT_OWNER_MCP_URL)
    expect(compose).toContain(`"TCP-LISTEN:${port},bind=${hostname},fork,reuseaddr"`)
  })

  it('serve on every interface of the container, on the port the webhook URL names', () => {
    expect(imageEnv('MASTRA_HOST')).toBe('0.0.0.0')
    expect(compose).toContain(`http://agent:${imageEnv('PORT')}/hdtp/webhook`)
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE ${imageEnv('PORT')}$`, 'm'))
  })

  it('name the image make builds', () => {
    const image = makefile.match(/^IMAGE := (\S+)$/m)?.[1]
    expect(image).toBeDefined()
    expect(compose).toContain(`image: ${image}:latest\n`)
  })

  it('build from files the build context admits', () => {
    const admitted = readFileSync('.dockerignore', 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('!'))
      .map((l) => l.slice(1).replace(/\/$/, ''))
    const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1]!.split(' '))
    expect(copied.length).toBeGreaterThan(0)
    for (const file of copied) expect(admitted, file).toContain(file)
  })
})
