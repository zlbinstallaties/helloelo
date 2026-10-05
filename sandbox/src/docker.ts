import { execFile } from 'node:child_process'

/*
 * Thin wrapper around the docker CLI. Everything that talks to Docker goes
 * through a DockerCli so tests can replace it.
 */

export interface DockerResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface DockerCli {
  run(args: string[], options?: { timeoutMs?: number }): Promise<DockerResult>
}

export class DockerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DockerError'
  }
}

export function createDockerCli(binary = 'docker'): DockerCli {
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        execFile(
          binary,
          args,
          {
            timeout: options.timeoutMs ?? 0,
            maxBuffer: 20 * 1024 * 1024,
            // The docker CLI needs no secrets; DOCKER_HOST is kept for remote daemons.
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: process.env.HOME ?? '/tmp',
              ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
            },
          },
          (error, stdout, stderr) => {
            const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
            if (err && typeof err.code === 'string') {
              resolve({ code: null, stdout, stderr: `docker kon niet starten: ${err.code}`, timedOut: false })
              return
            }
            resolve({
              code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
              stdout,
              stderr,
              timedOut: Boolean(err?.killed),
            })
          },
        )
      })
    },
  }
}

/** Runs a docker command that must succeed; returns trimmed stdout. */
export async function docker(cli: DockerCli, args: string[], timeoutMs = 60_000): Promise<string> {
  const result = await cli.run(args, { timeoutMs })
  if (result.code !== 0) {
    throw new DockerError(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`)
  }
  return result.stdout.trim()
}
