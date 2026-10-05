import { createDockerCli } from './docker.ts'
import { createSandbox } from './sandbox.ts'

/*
 * Run one step in the sandbox from the command line:
 *
 *   node --experimental-strip-types sandbox/src/cli.ts install <dir>
 *   node --experimental-strip-types sandbox/src/cli.ts build <dir>
 *
 * Env: DIG_SANDBOX_CA_BUNDLE (optional) for installs behind a TLS proxy.
 */

const [step, dir] = process.argv.slice(2)
if (!dir || !['install', 'build'].includes(step)) {
  console.error('usage: cli.ts install|build <project dir>')
  process.exit(1)
}

const sandbox = createSandbox({ cli: createDockerCli(), caBundle: process.env.DIG_SANDBOX_CA_BUNDLE || undefined })
const result =
  step === 'install'
    ? await sandbox.install(dir)
    : await sandbox.exec(dir, ['node_modules/.bin/vite', 'build'], { network: 'none' })
console.log(result.output)
process.exit(result.ok ? 0 : 1)
