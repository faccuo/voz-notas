import type { ToolExecutor } from './core/tools'
import type { ToolArgs } from './core/voice'

// The desktop half of remote control: connects to the pairing relay and
// answers tool calls coming from a paired phone, executing them through the
// SAME ToolExecutor the local voice session uses. The phone runs the voice;
// the vault stays here.
//
// Protocol over the relay (JSON):
//   phone → desktop:  { type: 'tool_call', id, name, args }
//   desktop → phone:  { type: 'tool_result', id, output }
//   relay → both:     { type: 'presence', desktop, mobile }

export interface RemoteBridgeConfig {
  relayUrl: string // e.g. wss://relay.example.com or ws://localhost:8787
  sessionId: string
  execute: (name: string, args: ToolArgs) => Promise<string>
  onStatus?: (status: 'connecting' | 'connected' | 'paired' | 'disconnected') => void
}

interface RemoteMessage {
  type: string
  id?: number
  name?: string
  args?: ToolArgs
  mobile?: boolean
}

export class RemoteBridge {
  private ws: WebSocket | null = null
  private stopped = false
  private retryTimer: number | null = null

  constructor(private config: RemoteBridgeConfig) {}

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close(1000, 'remote control disabled')
    this.ws = null
    this.config.onStatus?.('disconnected')
  }

  isRunning(): boolean {
    return !this.stopped && this.ws != null
  }

  private connect() {
    if (this.stopped) return
    this.config.onStatus?.('connecting')
    const base = this.config.relayUrl.replace(/\/+$/, '')
    const ws = new WebSocket(`${base}/ws/${this.config.sessionId}?role=desktop`)
    this.ws = ws

    ws.addEventListener('open', () => this.config.onStatus?.('connected'))

    ws.addEventListener('message', (e) => void this.onMessage(e))

    // Any close (laptop slept, relay redeployed…) → retry until stopped.
    ws.addEventListener('close', () => {
      if (this.stopped) return
      this.config.onStatus?.('disconnected')
      this.retryTimer = window.setTimeout(() => this.connect(), 3000)
    })
  }

  private async onMessage(e: MessageEvent) {
    let msg: RemoteMessage
    try {
      msg = JSON.parse(String(e.data)) as RemoteMessage
    } catch {
      return // not ours
    }
    if (msg.type === 'presence') {
      this.config.onStatus?.(msg.mobile ? 'paired' : 'connected')
      return
    }
    if (msg.type === 'tool_call' && typeof msg.name === 'string') {
      let output: string
      try {
        output = await this.config.execute(msg.name, msg.args ?? {})
      } catch (err) {
        output = 'Error: ' + (err as Error).message
      }
      // The socket may have dropped while the tool ran.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, output }))
      }
    }
  }
}

// An unguessable, URL-safe pairing session id (128 bits).
export function newSessionId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
