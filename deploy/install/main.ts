import { main } from './cli.ts'
import { terminalPrompts } from './prompts.ts'
import { realSys } from './sys.ts'

const prompts = terminalPrompts()
const code = await main(process.argv.slice(2), { sys: realSys((message) => prompts.say(message)), prompts }).catch((error) => {
  prompts.say(`Onverwachte fout: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
process.exit(code)
