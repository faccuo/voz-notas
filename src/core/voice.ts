// Framework-agnostic voice session over WebRTC + OpenAI Realtime.
// The only platform-specific bit — how to POST the SDP — is injected as `signalSdp`.

export interface VoiceSession {
  stop(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
}

export interface ToolDef {
  type: 'function'
  name: string
  description: string
  parameters: object
}

export interface VoiceConfig {
  instructions?: string
  tools?: ToolDef[]
  // Run a tool the model asked for; return its result as a string.
  onToolCall?: (name: string, args: any) => Promise<string>
  // Fired for every event on the data channel (transcripts, activity, etc.).
  onEvent?: (event: any) => void
}

export async function startVoiceSession(
  signalSdp: (offerSdp: string) => Promise<string>,
  config: VoiceConfig = {},
): Promise<VoiceSession> {
  const pc = new RTCPeerConnection()

  // Play the audio OpenAI sends back.
  const audioEl = new Audio()
  audioEl.autoplay = true
  pc.ontrack = (e) => (audioEl.srcObject = e.streams[0])

  // Capture the mic and send it over the connection.
  // Echo cancellation stops the model from hearing its own voice and cutting itself off.
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const micTracks = mic.getTracks()
  micTracks.forEach((track) => pc.addTrack(track, mic))
  let muted = false

  // Data channel: JSON events (session config, tool calls, transcripts).
  const dc = pc.createDataChannel('oai-events')
  const send = (msg: object) => {
    // Guard: the channel may have closed (session ended) before we reply.
    if (dc.readyState === 'open') dc.send(JSON.stringify(msg))
  }

  // Once the channel opens, declare our instructions + tools.
  dc.addEventListener('open', () => {
    if (config.instructions || config.tools) {
      send({
        type: 'session.update',
        session: {
          type: 'realtime', // required by the API
          ...(config.instructions ? { instructions: config.instructions } : {}),
          ...(config.tools ? { tools: config.tools, tool_choice: 'auto' } : {}),
        },
      })
    }
  })

  // Handle events from the model — including tool calls.
  // Only one response can be active at a time. Coalesce our response.create calls so
  // multiple tool calls in a turn don't collide ("conversation_already_has_active_response").
  let responseActive = false
  let wantResponse = false
  const requestResponse = () => {
    if (responseActive) {
      wantResponse = true
    } else {
      responseActive = true
      wantResponse = false
      send({ type: 'response.create' })
    }
  }

  dc.addEventListener('message', async (e) => {
    const event = JSON.parse(e.data)
    config.onEvent?.(event)

    if (event.type === 'response.created') responseActive = true
    if (event.type === 'response.done') {
      responseActive = false
      if (wantResponse) requestResponse()
    }

    if (event.type === 'response.function_call_arguments.done') {
      // The model wants to run a tool. Run it, return the result, then ask it to continue.
      let output = ''
      try {
        const args = JSON.parse(event.arguments || '{}')
        output = config.onToolCall ? await config.onToolCall(event.name, args) : ''
      } catch (err) {
        output = 'Error: ' + (err as Error).message
      }
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: event.call_id, output },
      })
      requestResponse()
    }

    if (event.type === 'error') {
      console.error('realtime error:', JSON.stringify(event.error ?? event, null, 2))
    }
  })

  // Offer -> (signaling) -> answer.
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  if (!offer.sdp) throw new Error('Failed to create SDP offer')
  const answerSdp = await signalSdp(offer.sdp)
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

  return {
    stop() {
      micTracks.forEach((track) => track.stop())
      pc.close()
    },
    setMuted(m: boolean) {
      muted = m
      // Disabling the track stops sending audio without dropping the connection.
      micTracks.forEach((track) => (track.enabled = !m))
    },
    isMuted() {
      return muted
    },
  }
}
