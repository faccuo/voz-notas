// Framework-agnostic voice session over WebRTC + OpenAI Realtime.
// The only platform-specific bit — how to POST the SDP — is injected as `signalSdp`.

export interface VoiceSession {
  stop(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  // Current audio loudness (0..1), max of your mic and the assistant's voice.
  getLevel(): number
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

  // Audio metering: read loudness from both the mic and the assistant's voice
  // so the UI can react to whoever is talking. Best-effort — never fatal.
  let audioCtx: AudioContext | null = null
  let micAnalyser: AnalyserNode | null = null
  let remoteAnalyser: AnalyserNode | null = null
  let meterBuf: Uint8Array<ArrayBuffer> | null = null
  try {
    audioCtx = new AudioContext()
    micAnalyser = audioCtx.createAnalyser()
    remoteAnalyser = audioCtx.createAnalyser()
    micAnalyser.fftSize = 512
    remoteAnalyser.fftSize = 512
    meterBuf = new Uint8Array(new ArrayBuffer(micAnalyser.fftSize))
  } catch {
    /* Web Audio unavailable — getLevel() just returns 0. */
  }
  const rms = (analyser: AnalyserNode | null): number => {
    if (!analyser || !meterBuf) return 0
    analyser.getByteTimeDomainData(meterBuf)
    let sum = 0
    for (let i = 0; i < meterBuf.length; i++) {
      const v = (meterBuf[i] - 128) / 128
      sum += v * v
    }
    return Math.sqrt(sum / meterBuf.length)
  }

  // Play the audio OpenAI sends back (and tap it for metering).
  const audioEl = new Audio()
  audioEl.autoplay = true
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0]
    if (audioCtx && remoteAnalyser) {
      try {
        audioCtx.createMediaStreamSource(e.streams[0]).connect(remoteAnalyser)
      } catch {
        /* some engines refuse a WebRTC remote stream as a source; mic still meters */
      }
    }
  }

  // Capture the mic and send it over the connection.
  // Echo cancellation stops the model from hearing its own voice and cutting itself off.
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const micTracks = mic.getTracks()
  micTracks.forEach((track) => pc.addTrack(track, mic))
  if (audioCtx && micAnalyser) {
    try {
      audioCtx.createMediaStreamSource(mic).connect(micAnalyser)
    } catch {
      /* ignore */
    }
  }
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

  const onMessage = async (e: MessageEvent) => {
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
  }
  dc.addEventListener('message', (e) => void onMessage(e))

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
      void audioCtx?.close()
    },
    setMuted(m: boolean) {
      muted = m
      // Disabling the track stops sending audio without dropping the connection.
      micTracks.forEach((track) => (track.enabled = !m))
    },
    isMuted() {
      return muted
    },
    getLevel() {
      // A little gain so normal speech reaches a satisfying peak; clamp to 1.
      return Math.min(1, Math.max(rms(micAnalyser), rms(remoteAnalyser)) * 2.4)
    },
  }
}
