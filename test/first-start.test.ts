import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIRST_START_FILE, FirstStartUnreadable, firstStart } from '../src/hdtp/first-start.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'hdtp-agent-data-'))

describe('the first-start time', () => {
  it('is written at the first start and read back, unchanged, at every later one', () => {
    const dir = join(fresh(), 'nested')
    expect(firstStart(dir, 1_800_000_000)).toBe(1_800_000_000)
    expect(firstStart(dir, 1_800_000_500)).toBe(1_800_000_000)
    expect(JSON.parse(readFileSync(join(dir, FIRST_START_FILE), 'utf8'))).toEqual({ first_start: 1_800_000_000 })
    // Nothing else is left in the directory.
    expect(readdirSync(dir)).toEqual([FIRST_START_FILE])
  })

  it('refuses a file that is not a first-start time, rather than start afresh', () => {
    for (const text of ['', 'not json', 'null', '{}', '{"first_start":"1800000000"}', '{"first_start":0}', '{"first_start":1.5}']) {
      const dir = fresh()
      writeFileSync(join(dir, FIRST_START_FILE), text)
      expect(() => firstStart(dir, 1_800_000_000), text).toThrow(FirstStartUnreadable)
      expect(readFileSync(join(dir, FIRST_START_FILE), 'utf8'), text).toBe(text)
    }
  })
})
