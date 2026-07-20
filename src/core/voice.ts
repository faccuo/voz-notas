// Framework-agnostic voice session over WebRTC + OpenAI Realtime.
// The only platform-specific bit — how to POST the SDP — is injected as `signalSdp`.

export interface VoiceSession {
  stop(): void
}

// signalSdp: given our offer SDP, return OpenAI's answer SDP.
export async function startVoiceSession(
  signalSdp: (offerSdp: string) => Promise<string>,
): Promise<VoiceSession> {
  const pc = new RTCPeerConnection()

  // Play the audio OpenAI sends back.
  const audioEl = new Audio()
  audioEl.autoplay = true
  pc.ontrack = (e) => (audioEl.srcObject = e.streams[0])

  // Capture the mic and send it over the connection.
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  mic.getTracks().forEach((track) => pc.addTrack(track, mic))

  // Data channel for JSON events (transcripts now, tool calls in P2).
  const dc = pc.createDataChannel('oai-events')
  dc.addEventListener('message', (e) => console.log('event:', e.data))

  // Offer -> (signaling) -> answer.
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  if (!offer.sdp) throw new Error('Failed to create SDP offer')
  const answerSdp = await signalSdp(offer.sdp)
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

  return {
    stop() {
      mic.getTracks().forEach((track) => track.stop())
      pc.close()
    },
  }
}
