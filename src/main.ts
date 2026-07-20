// M1 — "Hello voice": connect the browser to OpenAI Realtime over WebRTC.

// --- tiny UI: a button + a status line ---
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <h1>voz-notas</h1>
  <button id="start">Start talking</button>
  <p id="status">idle</p>
`
const startBtn = document.querySelector<HTMLButtonElement>('#start')!
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!
const setStatus = (s: string) => (statusEl.textContent = s)

startBtn.addEventListener('click', () => {
  startBtn.disabled = true
  connect().catch((err) => {
    console.error(err)
    setStatus('error: ' + err.message)
    startBtn.disabled = false
  })
})

async function connect() {
  // 1) Ask OUR backend for a short-lived ephemeral token.
  setStatus('getting token…')
  const tokenRes = await fetch('/token')
  const { value: EPHEMERAL_KEY } = await tokenRes.json()

  // 2) The WebRTC peer connection (browser <-> OpenAI).
  const pc = new RTCPeerConnection()

  // 3) Play whatever audio OpenAI sends back.
  const audioEl = new Audio()
  audioEl.autoplay = true
  pc.ontrack = (e) => (audioEl.srcObject = e.streams[0])

  // 4) Capture the mic and send it over the connection.
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  pc.addTrack(mic.getTracks()[0])

  // 5) A data channel for JSON events (transcripts now, tool calls later).
  const dc = pc.createDataChannel('oai-events')
  dc.addEventListener('message', (e) => console.log('event:', e.data))

  // 6) Create our SDP offer and set it as our local description.
  setStatus('connecting…')
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  // 7) Signaling = one HTTP POST: send our offer SDP, get OpenAI's answer SDP.
  const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${EPHEMERAL_KEY}`,
      'Content-Type': 'application/sdp',
    },
  })
  const answer: RTCSessionDescriptionInit = {
    type: 'answer',
    sdp: await sdpRes.text(),
  }
  await pc.setRemoteDescription(answer)

  setStatus('connected — say something!')
}
