import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LcuCredentials {
  port: number
  password: string
  protocol: string
}

/** Lockfile format: `LeagueClient:<pid>:<port>:<password>:<protocol>` */
export function parseLockfile(content: string): LcuCredentials | null {
  const parts = content.trim().split(':')
  if (parts.length < 5) return null
  const port = Number(parts[2])
  if (!Number.isInteger(port) || port <= 0) return null
  return { port, password: parts[3], protocol: parts[4] }
}

/** Parses `--app-port=` and `--remoting-auth-token=` from LeagueClientUx's command line. */
export function parseCommandLine(commandLine: string): LcuCredentials | null {
  const port = /--app-port=["']?(\d+)/.exec(commandLine)?.[1]
  const token = /--remoting-auth-token=["']?([\w-]+)/.exec(commandLine)?.[1]
  if (!port || !token) return null
  return { port: Number(port), password: token, protocol: 'https' }
}

export const DEFAULT_LEAGUE_PATHS =
  process.platform === 'darwin'
    ? ['/Applications/League of Legends.app/Contents/LoL']
    : ['C:\\Riot Games\\League of Legends', 'D:\\Riot Games\\League of Legends', 'C:\\Program Files\\Riot Games\\League of Legends']

/** Runs a command and resolves with its stdout, or '' on any error or timeout. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    )
  })
}

async function fromProcessList(): Promise<LcuCredentials | null> {
  let output = ''
  if (process.platform === 'win32') {
    output = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'LeagueClientUx.exe\'" | Select-Object -ExpandProperty CommandLine'
    ])
  } else if (process.platform === 'darwin') {
    output = await run('ps', ['-A', '-o', 'args'])
    output = output.split('\n').find((line) => line.includes('LeagueClientUx')) ?? ''
  }
  return output ? parseCommandLine(output) : null
}

async function fromLockfile(paths: string[]): Promise<LcuCredentials | null> {
  for (const dir of paths) {
    try {
      const creds = parseLockfile(await readFile(join(dir, 'lockfile'), 'utf8'))
      if (creds) return creds
    } catch {
      // no lockfile in this folder, try the next one
    }
  }
  return null
}

/** Finds the credentials of a running League client, or null if it is not running. */
export async function findCredentials(customPath?: string): Promise<LcuCredentials | null> {
  // the process command line works for any install path, so try it before guessing lockfile locations
  const fromProcess = await fromProcessList()
  if (fromProcess) return fromProcess
  const paths = customPath ? [customPath, ...DEFAULT_LEAGUE_PATHS] : DEFAULT_LEAGUE_PATHS
  return fromLockfile(paths)
}
