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
