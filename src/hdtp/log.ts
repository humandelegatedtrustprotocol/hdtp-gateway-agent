// One line per thing that happened, named by a code. Ids may ride along; error text, message text
// and secrets never do, so a log can be shared without leaking what a contact wrote.

export type Fields = Record<string, string | number | boolean>

export interface Log {
  info(code: string, fields?: Fields): void
  warn(code: string, fields?: Fields): void
}

export const consoleLog: Log = {
  info(code, fields) {
    console.log(JSON.stringify({ level: 'info', code, ...fields }))
  },
  warn(code, fields) {
    console.warn(JSON.stringify({ level: 'warn', code, ...fields }))
  },
}

/** Where a line is also written: Mastra's observability log, which Studio's Logs page lists. */
export interface ObservedLog {
  info(message: string, data?: Fields): void
  warn(message: string, data?: Fields): void
}

/** consoleLog's line, and the same code and fields to `observed`. */
export function observedLog(observed: ObservedLog): Log {
  return {
    info(code, fields) {
      consoleLog.info(code, fields)
      observed.info(code, fields)
    },
    warn(code, fields) {
      consoleLog.warn(code, fields)
      observed.warn(code, fields)
    },
  }
}

/**
 * Runs `fn` in a span of its own, named `name`: the lines logged while it runs, and an agent run it
 * starts, are kept as one trace. The span ends when the promise `fn` returns settles.
 */
export type Trace = <T>(name: string, fn: () => Promise<T>) => Promise<T>

/** No spans: the runtime's tracer where nothing records traces. */
export const untraced: Trace = (_name, fn) => fn()
