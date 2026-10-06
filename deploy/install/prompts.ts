import { createInterface } from 'node:readline'

/** Questions for the person running the installer. Secrets are read without echo and never logged. */
export interface Prompts {
  ask(question: string, options?: { default?: string; secret?: boolean }): Promise<string>
  confirm(question: string, defaultYes?: boolean): Promise<boolean>
  say(message: string): void
}

export function terminalPrompts(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Prompts {
  const lines: string[] = []
  const waiting: Array<(line: string | null) => void> = []
  let closed = false
  const rl = createInterface({ input, terminal: false })
  rl.on('line', (line) => {
    const next = waiting.shift()
    if (next) next(line)
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    for (const next of waiting.splice(0)) next(null)
  })

  function readLine(): Promise<string | null> {
    if (lines.length) return Promise.resolve(lines.shift()!)
    if (closed) return Promise.resolve(null)
    return new Promise((resolve) => waiting.push(resolve))
  }

  /** Reads one line with echo switched off; falls back to plain reading when there is no terminal. */
  async function readSecret(): Promise<string | null> {
    if (!input.isTTY) return readLine()
    rl.pause()
    input.setRawMode(true)
    input.resume()
    return new Promise((resolve) => {
      let value = ''
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            input.setRawMode(false)
            input.off('data', onData)
            output.write('\n')
            rl.resume()
            return resolve(value)
          }
          if (char === '\u0003') {
            input.setRawMode(false)
            output.write('\n')
            process.exit(130)
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
          else if (char >= ' ') value += char
        }
      }
      input.on('data', onData)
    })
  }

  return {
    say: (message) => output.write(`${message}\n`),
    async ask(question, options = {}) {
      output.write(`${question}${options.default ? ` [${options.default}]` : ''}: `)
      const answer = options.secret ? await readSecret() : await readLine()
      if (answer === null) throw new Error('Geen invoer meer ontvangen.')
      return answer.trim() || options.default || ''
    },
    async confirm(question, defaultYes = false) {
      output.write(`${question} (${defaultYes ? 'J/n' : 'j/N'}): `)
      const answer = (await readLine())?.trim().toLowerCase() ?? ''
      if (!answer) return defaultYes
      return ['j', 'ja', 'y', 'yes'].includes(answer)
    },
  }
}
