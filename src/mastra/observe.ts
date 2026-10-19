// The runtime's spans and log lines, recorded by Mastra's observability for Studio to show.
//
// Every line is written inside a span, and so carries a trace id: the sweep (retention.ts) deletes a
// trace and, with it, the lines that name it, and Mastra's public API deletes log lines no other
// way. A line logged where no span is open (a wait loop's, the one line of a start) is given a span
// of its own, named by its code.

import type { Mastra } from '@mastra/core'
import { SpanType, type AnySpan } from '@mastra/core/observability'
import { executeWithContext, getCurrentSpan } from '@mastra/core/observability/context-storage'
import { observedLog, type Fail, type Fields, type Log, type Trace } from '../hdtp/log.ts'
import { refusalCode } from '../hdtp/node.ts'

export function observe(mastra: Mastra): { log: Log; trace: Trace; fail: Fail } {
  const instance = mastra.observability.getDefaultInstance()
  if (!instance?.getLoggerContext) throw new Error('observability_unconfigured')
  const logger = instance.getLoggerContext.bind(instance)
  const start = (name: string) => instance.startSpan({ type: SpanType.GENERIC, name })
  // A span is marked failed by a code alone: an error's text and its stack may carry what a contact
  // wrote or where the code runs, and the store is shown to whoever opens Studio.
  const coded = (code: string) => {
    const error = new Error(code)
    error.stack = undefined
    return error
  }
  // A loop started inside a span keeps that span as its context after the span has ended.
  const open = (span: AnySpan | undefined) => (span && !span.endTime ? span : undefined)

  const trace: Trace = async (name, fn) => {
    const span = start(name)
    let result: Awaited<ReturnType<typeof fn>>
    try {
      result = await executeWithContext({ span, fn })
    } catch (e) {
      span.error({ error: coded(refusalCode(e)), endSpan: true })
      throw e
    }
    span.end()
    return result
  }

  // The span stays open: the work in it goes on, and the span's end keeps it marked.
  const fail: Fail = (code) => open(getCurrentSpan())?.error({ error: coded(code), endSpan: false })

  const write = (level: 'info' | 'warn', code: string, fields?: Fields) => {
    const current = open(getCurrentSpan())
    if (current) return logger(current)[level](code, fields)
    const span = start(code)
    logger(span)[level](code, fields)
    span.end()
  }

  return {
    trace,
    fail,
    log: observedLog({ info: (code, fields) => write('info', code, fields), warn: (code, fields) => write('warn', code, fields) }),
  }
}
