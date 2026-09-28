import { EventEmitter } from 'node:events'
import https from 'node:https'
import WebSocket from 'ws'
import type { LcuCredentials } from './credentials'

/**
 * The League client serves its API on 127.0.0.1 with a self-signed Riot certificate.
 * We only ever talk to localhost, so certificate validation is disabled for this agent.
 */
const agent = new https.Agent({ rejectUnauthorized: false })

export interface LcuEvent {
  uri: string
  eventType: 'Create' | 'Update' | 'Delete'
  data: unknown
}

export class LcuHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class LcuClient extends EventEmitter {
  private ws: WebSocket | null = null

  constructor(private readonly creds: LcuCredentials) {
    super()
  }

  private get auth(): string {
    return 'Basic ' + Buffer.from(`riot:${this.creds.password}`).toString('base64')
  }

  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: this.creds.port,
          path,
          method,
          agent,
          headers: {
            Authorization: this.auth,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
          },
          timeout: 8000
        },
        (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (raw += c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            let json: unknown = undefined
            try {
              json = raw ? JSON.parse(raw) : undefined
            } catch {
              json = raw
            }
            if (status >= 200 && status < 300) resolve(json as T)
            else {
              const msg = (json as { message?: string } | undefined)?.message ?? `LCU ${status} ${method} ${path}`
              reject(new LcuHttpError(status, msg))
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('LCU timeout')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  /** Opens the WAMP websocket and subscribes to the given LCU event names. */
  connect(events: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${this.creds.port}/`, 'wamp', {
        headers: { Authorization: this.auth },
        rejectUnauthorized: false
      })
      this.ws = ws
      ws.once('open', () => {
        // WAMP 1.0 subscribe: [5, topic]
        for (const e of events) ws.send(JSON.stringify([5, e]))
        resolve()
      })
      // keep a permanent listener: an unhandled 'error' event would crash the main process
      ws.on('error', (err) => reject(err))
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw))
          // WAMP event: [8, topic, payload]
          if (Array.isArray(msg) && msg[0] === 8 && msg[2]) this.emit('event', msg[2] as LcuEvent)
        } catch {
          /* ignore malformed frames */
        }
      })
      ws.on('close', () => this.emit('close'))
    })
  }

  close(): void {
    this.ws?.removeAllListeners()
    this.ws?.close()
    this.ws = null
    this.emit('close')
  }
}
