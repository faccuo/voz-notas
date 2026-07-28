import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, requestUrl } from 'obsidian'
import QRCode from 'qrcode'
import { startVoiceSession, type VoiceSession, type ToolDef, type ToolArgs, type RealtimeEvent } from './core/voice'
import { VaultToolExecutor } from './vault-tools'
import { RemoteBridge, newSessionId } from './remote'
import { newSecret } from './core/crypto'
import { VozNotasView, VIEW_TYPE } from './view'
import { t, setLang, type Lang } from './i18n'

interface VozNotasSettings {
  apiKey: string
  reasoningModel: string
  agentsFile: string
  language: Lang
  saveSessions: boolean
  assistantName: string
  notesFolder: string
  remoteEnabled: boolean
  relayUrl: string
  remoteSessionId: string
  remoteSecret: string
}

const DEFAULT_SETTINGS: VozNotasSettings = {
  apiKey: '',
  reasoningModel: 'gpt-5',
  agentsFile: 'AGENTS.md',
  language: 'en',
  saveSessions: true,
  assistantName: 'Eco',
  notesFolder: 'Eco',
  remoteEnabled: false,
  relayUrl: 'ws://localhost:8787',
  remoteSessionId: '',
  remoteSecret: '',
}

const INSTRUCTIONS = `You are a voice assistant over the user's personal Obsidian notes (Markdown, linked with [[wikilinks]], tagged with #tags).

Read tools:
- search_notes(query): find relevant notes (returns paths + short excerpts).
- read_note(path): read a note's full content (for detail, summaries, opinions, or to find related [[links]]).
- open_note(path): open a note in the user's Obsidian window (when they ask to open or show one).
- get_active_note(): the note the user currently has open, with its content — for "this note", "what I'm looking at".
- find_note_by_name(name): find notes by their filename/title (not content).
- list_folders(query?): find/list folders (to discover folder paths). Use this before list_folder when you don't know the exact folder.
- list_folder(folder): list the notes inside a folder.
- get_links(path): a note's [[links]] and backlinks — for related notes / the graph.
- get_outline(path): a note's headings (its structure).
- list_tags(): all #tags used in the vault.
- find_notes_by_tag(tag): notes that have a given #tag.

Write tools (they change the vault):
- create_note(title, content): create a new note.
- append_to_note(text): append to the note the user currently has open.
- insert_text(text): insert at the cursor / replace the selection in the open note.

Reasoning & memory:
- think(question, paths): delegate DEEP reasoning to a stronger model (see rule below).
- remember_rule(rule): save a lasting behaviour preference to your AGENTS.md (applies in future sessions).

Behaviour:
- Be snappy. Use search_notes AT MOST twice for one request, then act — NEVER search in a loop.
- For an OPINION, a judgment, deep analysis, synthesis across notes, or when they say "think hard"/"analyze": do one or two searches to gather the relevant note paths, then you MUST call think(question, paths) and speak its answer. Do NOT answer these yourself and do NOT keep searching.
- For a quick factual question about ONE note: search once, read_note the best hit, and answer yourself.
- After a normal search, summarize what you found in one or two short sentences and name the notes.
- For "related ideas", read a note and follow its [[wikilinks]]; offer them.
- If they ask "what else", search again with a related query.
- If they ask to open/show a note, call open_note.
- For "related ideas" or "what links here", use get_links. For tags, use list_tags / find_notes_by_tag.
- When the user asks you to remember a preference or change how you behave from now on (e.g. "when I talk about writing, don't give creative ideas"), confirm briefly, then call remember_rule with a concise rule.
- When the user says goodbye or asks to end the session ("adiós", "cierra la sesión", "we're done"), call end_session and then say a SHORT goodbye — the session closes when you finish speaking. No confirmation needed.
- Before any write (create_note, append_to_note, insert_text, remember_rule): ask a SHORT confirmation like "¿lo hago?" — do NOT read the whole text back. Only write after they say yes.
Always use the exact path from search_notes. Respond in the user's language, briefly and conversationally.
Do NOT narrate your steps or announce which tool you are using — just act and give the result. Keep replies short. Never read a note verbatim unless asked.`

const SEARCH_NOTES_TOOL: ToolDef = {
  type: 'function',
  name: 'search_notes',
  description: "Search the user's Obsidian notes; returns note paths and short excerpts.",
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look for in the notes.' } },
    required: ['query'],
  },
}

const READ_NOTE_TOOL: ToolDef = {
  type: 'function',
  name: 'read_note',
  description: 'Read the full content of one note by its path (paths come from search_notes).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The note path to read.' } },
    required: ['path'],
  },
}

const OPEN_NOTE_TOOL: ToolDef = {
  type: 'function',
  name: 'open_note',
  description: "Open a note in the user's Obsidian window so they can see it.",
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The note path to open.' } },
    required: ['path'],
  },
}

const CREATE_NOTE_TOOL: ToolDef = {
  type: 'function',
  name: 'create_note',
  description: 'Create a new note with the given text. Only call AFTER the user confirms.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title (becomes the filename).' },
      content: { type: 'string', description: 'The note body.' },
    },
    required: ['title', 'content'],
  },
}

const APPEND_NOTE_TOOL: ToolDef = {
  type: 'function',
  name: 'append_to_note',
  description: 'Append text to the end of the currently open note. Only call AFTER the user confirms.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The text to append.' } },
    required: ['text'],
  },
}

const ACTIVE_NOTE_TOOL: ToolDef = {
  type: 'function',
  name: 'get_active_note',
  description: "Get the note the user currently has open (foreground), with its content. Use for 'this note' / 'what I'm looking at'.",
  parameters: { type: 'object', properties: {}, required: [] },
}

const FIND_BY_NAME_TOOL: ToolDef = {
  type: 'function',
  name: 'find_note_by_name',
  description: 'Find notes by their filename/title (not content). Returns matching paths.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The name or title to look for.' } },
    required: ['name'],
  },
}

const LIST_FOLDER_TOOL: ToolDef = {
  type: 'function',
  name: 'list_folder',
  description: 'List the notes inside a folder, by folder path.',
  parameters: {
    type: 'object',
    properties: { folder: { type: 'string', description: 'Folder path, e.g. "02 - ESCRITURA".' } },
    required: ['folder'],
  },
}

const LIST_FOLDERS_TOOL: ToolDef = {
  type: 'function',
  name: 'list_folders',
  description: 'List/find folders in the vault, optionally filtered by name. Use to discover folder paths before list_folder.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional name to filter, e.g. "escritura". Empty = all folders.' },
    },
    required: [],
  },
}

const GET_LINKS_TOOL: ToolDef = {
  type: 'function',
  name: 'get_links',
  description: "A note's outgoing [[links]] and its backlinks (the graph around it). Use for related notes.",
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The note path.' } },
    required: ['path'],
  },
}

const GET_OUTLINE_TOOL: ToolDef = {
  type: 'function',
  name: 'get_outline',
  description: "A note's headings (its structure), without the full text.",
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'The note path.' } },
    required: ['path'],
  },
}

const LIST_TAGS_TOOL: ToolDef = {
  type: 'function',
  name: 'list_tags',
  description: 'All #tags used in the vault.',
  parameters: { type: 'object', properties: {}, required: [] },
}

const FIND_BY_TAG_TOOL: ToolDef = {
  type: 'function',
  name: 'find_notes_by_tag',
  description: 'Notes that have a given #tag.',
  parameters: {
    type: 'object',
    properties: { tag: { type: 'string', description: 'The tag, with or without #.' } },
    required: ['tag'],
  },
}

const INSERT_TEXT_TOOL: ToolDef = {
  type: 'function',
  name: 'insert_text',
  description: 'Insert text at the cursor in the open note, or replace the selected text. Only call AFTER the user confirms.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The text to insert.' } },
    required: ['text'],
  },
}

const THINK_TOOL: ToolDef = {
  type: 'function',
  name: 'think',
  description:
    'Delegate DEEP reasoning to a stronger model. Use for opinions, judgments, deep analysis, or synthesis across several notes, or when the user asks to "think hard". Pass the question and the relevant note paths.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question or task to reason about.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relevant note paths to use as context.',
      },
    },
    required: ['question'],
  },
}

const REMEMBER_TOOL: ToolDef = {
  type: 'function',
  name: 'remember_rule',
  description:
    'Persist a lasting behaviour preference to your AGENTS.md so it applies in future sessions. Use when the user says "from now on…", "remember…", or "when I talk about X, do/don\'t Y". Only call AFTER confirming.',
  parameters: {
    type: 'object',
    properties: {
      rule: {
        type: 'string',
        description: 'A concise rule, e.g. "When the user talks about writing, do not offer creative ideas unless asked."',
      },
    },
    required: ['rule'],
  },
}

const END_SESSION_TOOL: ToolDef = {
  type: 'function',
  name: 'end_session',
  description:
    'End the voice session. Call when the user says goodbye or asks to close/stop the session ("adiós", "cierra", "we\'re done"). Say a brief goodbye after calling it — the session closes once you finish speaking.',
  parameters: { type: 'object', properties: {}, required: [] },
}


// A short human label for what a tool call is doing — the "Searching…" /
// "Thinking…" feedback shown in the panel (and in notices for remote calls).
function activityLabel(name: string, args: ToolArgs): string {
  if (name === 'search_notes') return t('activity.search', String(args?.query ?? ''))
  if (name === 'find_note_by_name') return t('activity.search', String(args?.name ?? ''))
  if (name === 'find_notes_by_tag') return t('activity.search', '#' + String(args?.tag ?? ''))
  if (name === 'read_note' || name === 'get_outline' || name === 'get_links' || name === 'open_note') {
    const file = String(args?.path ?? '').split('/').pop() ?? ''
    return t('activity.read', file.replace(/\.md$/, ''))
  }
  if (name === 'think') return t('activity.think')
  if (name === 'create_note' || name === 'append_to_note' || name === 'insert_text' || name === 'remember_rule') {
    return t('activity.write')
  }
  return t('activity.browse')
}

export default class VozNotasPlugin extends Plugin {
  settings!: VozNotasSettings // set in onload() via loadSettings()
  session: VoiceSession | null = null
  tools!: VaultToolExecutor // set in onload(), after settings are loaded
  remote: RemoteBridge | null = null
  // Transcript of the current session, kept here (not in the view) so it
  // survives the panel being closed. Saved as a note when the session ends.
  sessionLog: Array<{ role: 'user' | 'assistant'; id?: string; text: string }> = []
  sessionConsulted = new Set<string>()
  sessionStart: Date | null = null
  sessionNotePath: string | null = null
  private flushTimer: number | null = null
  // Set when the model calls end_session: we close AFTER its goodbye finishes playing.
  private pendingEndSession = false
  private endFallbackTimer: number | null = null
  private statusBarEl: HTMLElement | null = null

  async onload() {
    await this.loadSettings()

    // The desktop implementation of ToolExecutor: runs every tool against the
    // local vault. The remote bridge (mobile) will call this same object.
    this.tools = new VaultToolExecutor({
      app: this.app,
      getSettings: () => this.settings,
      onConsulted: (path) => this.noteConsulted(path),
    })

    // Register the settings pane (where the API key lives).
    this.addSettingTab(new VozNotasSettingTab(this.app, this))

    // The ribbon icon ONLY opens/closes the panel. The call is controlled from
    // the panel itself: orb = connect/mute, red button or "goodbye" = hang up.
    this.addRibbonIcon('mic', 'voz-notas', () => void this.togglePanel())

    // Status bar: while a call is live, a pulsing dot — so a hot mic is never
    // invisible, even with the panel closed. Click to reopen the panel.
    this.statusBarEl = this.addStatusBarItem()
    this.statusBarEl.addClass('vn-statusbar', 'mod-clickable')
    this.statusBarEl.onClickEvent(() => void this.activateView())
    this.addCommand({
      id: 'toggle-voice',
      name: 'Start / end voice session',
      callback: () => void this.toggleVoice(),
    })
    this.addCommand({
      id: 'toggle-mute',
      name: 'Toggle mute',
      callback: () => this.toggleMute(),
    })

    // The side panel (transcript + consulted notes + orb).
    this.registerView(VIEW_TYPE, (leaf) => new VozNotasView(leaf, this))
    this.addCommand({
      id: 'open-panel',
      name: 'Open panel',
      callback: () => this.activateView(),
    })

    // Keep the search index live: whatever changes the vault — the assistant's
    // own writes, manual edits, sync — updates the in-memory cache, so a note
    // created seconds ago is immediately searchable.
    this.registerEvent(this.app.vault.on('create', (f) => void this.tools.refreshIndexFile(f)))
    this.registerEvent(this.app.vault.on('modify', (f) => void this.tools.refreshIndexFile(f)))
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        this.tools.dropFromIndex(oldPath)
        void this.tools.refreshIndexFile(f)
      }),
    )
    this.registerEvent(this.app.vault.on('delete', (f) => this.tools.dropFromIndex(f.path)))

    // Warm the notes cache once the vault is ready. (onload runs before the file
    // list is populated, which would cache an empty vault.)
    this.app.workspace.onLayoutReady(() => {
      void this.tools.readVault()
      // Resume remote control if it was enabled (after the cache warm-up starts,
      // so a phone's first search doesn't hit an empty index).
      if (this.settings.remoteEnabled) this.startRemote()
    })
  }

  // --- Remote control: answer tool calls from a paired phone via the relay ---

  // Make sure a session id AND its E2E secret exist (they pair for life:
  // regenerating one regenerates both, invalidating old phones).
  ensurePairing() {
    if (this.settings.remoteSessionId && this.settings.remoteSecret) return
    if (!this.settings.remoteSessionId) this.settings.remoteSessionId = newSessionId()
    if (!this.settings.remoteSecret) this.settings.remoteSecret = newSecret()
    void this.saveSettings()
  }

  // The string inside the pairing QR. The secret travels screen → camera,
  // never through the relay.
  pairingPayload(): string {
    this.ensurePairing()
    return JSON.stringify({
      v: 1,
      relay: this.settings.relayUrl,
      session: this.settings.remoteSessionId,
      secret: this.settings.remoteSecret,
    })
  }

  startRemote() {
    if (this.remote) return
    this.ensurePairing()
    this.remote = new RemoteBridge({
      relayUrl: this.settings.relayUrl,
      sessionId: this.settings.remoteSessionId,
      secret: this.settings.remoteSecret,
      // The same executor the local voice session uses — this line IS the product.
      execute: (name, args) => {
        // Make the phone's activity visible on the desktop: a notice always
        // (works with the panel closed) and an activity line if it's open.
        // Service calls (bootstrap, transcript flushes) stay silent — they
        // are plumbing, not user activity, and flushes repeat every few turns.
        if (name !== 'init_session' && name !== 'save_session') {
          const label = t('activity.remote', activityLabel(name, args))
          new Notice(label)
          this.getView()?.addActivity(label)
        }
        return this.tools.execute(name, args)
      },
      onStatus: (status) => new Notice(t(`remote.status.${status}`)),
    })
    this.remote.start()
  }

  stopRemote() {
    this.remote?.stop()
    this.remote = null
  }

  onunload() {
    this.stopRemote()
    this.session?.stop()
    this.session = null
    // Best-effort: the incremental flushes have already saved everything but
    // possibly the very last turn.
    void this.flushSessionNote()
  }

  // --- Side panel ---
  getView(): VozNotasView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE)
    return leaves.length ? (leaves[0].view as VozNotasView) : null
  }

  // Show/hide the panel. Closing it does NOT hang up a live call — the call
  // lives in the plugin, and the panel reattaches to it when reopened.
  async togglePanel() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE)
    if (leaves.length > 0) leaves.forEach((leaf) => leaf.detach())
    else await this.activateView()
  }

  async activateView(): Promise<VozNotasView> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)
      await leaf?.setViewState({ type: VIEW_TYPE, active: true })
    }
    if (leaf) await this.app.workspace.revealLeaf(leaf)
    return leaf?.view as VozNotasView
  }

  // Route realtime events to the session log (memory) and the panel (UI).
  onRealtimeEvent(event: RealtimeEvent) {
    // Deferred hang-up: the model called end_session and has now finished
    // speaking its goodbye — close for real.
    if (this.pendingEndSession && event.type === 'output_audio_buffer.stopped') {
      this.pendingEndSession = false
      if (this.endFallbackTimer != null) window.clearTimeout(this.endFallbackTimer)
      this.endFallbackTimer = null
      if (this.session) void this.toggleVoice()
      return
    }

    // Log first — it must work even with the panel closed. Same placeholder
    // trick as the UI: reserve the user's turn on speech, fill it when the
    // (slower) transcription arrives, so the saved note reads in order.
    switch (event.type) {
      case 'conversation.item.added':
      case 'conversation.item.created':
        if (event.item?.role === 'user' && event.item.id) {
          const id = event.item.id
          if (!this.sessionLog.some((e) => e.id === id)) {
            this.sessionLog.push({ role: 'user', id, text: '' })
          }
        }
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const entry = this.sessionLog.find((e) => e.id === event.item_id)
        if (entry) entry.text = (event.transcript ?? '').trim()
        this.scheduleSessionFlush()
        break
      }
      case 'response.output_audio_transcript.done':
        if (event.transcript?.trim()) {
          this.sessionLog.push({ role: 'assistant', text: event.transcript.trim() })
          this.scheduleSessionFlush()
        }
        break
    }

    const view = this.getView()
    if (!view) return
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
      case 'response.output_audio.delta':
        view.pulse()
        break
      case 'conversation.item.added':
      case 'conversation.item.created':
        if (event.item?.role === 'user' && event.item?.id) view.addUserPlaceholder(event.item.id)
        break
      case 'response.output_audio_transcript.delta':
        view.appendAssistant(event.delta ?? '')
        view.pulse()
        break
      case 'response.output_audio_transcript.done':
        view.finishAssistant()
        break
      case 'conversation.item.input_audio_transcription.completed':
        view.fillUser(event.item_id ?? '', event.transcript ?? '')
        break
    }
  }

  // Where the assistant keeps its things: new notes in <folder>, session
  // transcripts (its memory) in <folder>/sessions. Defaults to "Eco".
  getNotesFolder(): string {
    return this.settings.notesFolder?.trim().replace(/\/+$/, '') || 'Eco'
  }

  getSessionsFolder(): string {
    return `${this.getNotesFolder()}/sessions`
  }

  // Reflect the call state in the status bar (red pulsing dot = mic live,
  // grey still dot = muted, hidden = no call).
  updateStatusBar() {
    const el = this.statusBarEl
    if (!el) return
    el.empty()
    el.toggleClass('is-live', !!this.session)
    if (!this.session) return
    const name = this.settings.assistantName?.trim() || 'Eco'
    const muted = this.session.isMuted()
    el.createSpan({ cls: 'vn-sb-dot' + (muted ? ' is-muted' : '') })
    el.createSpan({ text: `${name} · ${muted ? t('statusbar.muted') : t('statusbar.live')}` })
  }

  // A tool touched this note — track it for the session note and show it in the panel.
  noteConsulted(path: string) {
    this.sessionConsulted.add(path)
    this.getView()?.addConsulted(path)
  }

  // The session is saved INCREMENTALLY: the note is created on the first turn
  // and rewritten (debounced) after every exchange — so Cmd+Q, a crash or a
  // dead battery lose at most the last second. Because it's a normal note,
  // search_notes indexes it → past conversations become memory for free, and
  // the [[wikilinks]] to consulted notes tie sessions into the graph.
  scheduleSessionFlush() {
    if (!this.settings.saveSessions) return
    if (this.flushTimer != null) window.clearTimeout(this.flushTimer)
    this.flushTimer = window.setTimeout(() => void this.flushSessionNote(), 800)
  }

  async flushSessionNote() {
    if (!this.settings.saveSessions) return
    const turns = this.sessionLog.filter((e) => e.text)
    if (turns.length === 0) return
    try {
      const d = this.sessionStart ?? new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const time = `${pad(d.getHours())}.${pad(d.getMinutes())}`

      const name = this.settings.assistantName?.trim() || 'Eco'
      const lines = turns.map((e) => (e.role === 'user' ? `**Me:** ${e.text}` : `**${name}:** ${e.text}`))
      const consulted = [...this.sessionConsulted].map((p) => `- [[${p.replace(/\.md$/, '')}]]`)
      const body = [
        `# Voice session — ${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
        '',
        lines.join('\n\n'),
        ...(consulted.length ? ['', '## Notes consulted', '', consulted.join('\n')] : []),
        '',
      ].join('\n')

      if (!this.sessionNotePath) {
        if (!this.app.vault.getAbstractFileByPath(this.getSessionsFolder())) {
          await this.app.vault.createFolder(this.getSessionsFolder()).catch(() => {})
        }
        let path = `${this.getSessionsFolder()}/${day} ${time}.md`
        let n = 1
        while (this.app.vault.getAbstractFileByPath(path)) path = `${this.getSessionsFolder()}/${day} ${time} (${++n}).md`
        await this.app.vault.create(path, body)
        this.sessionNotePath = path
      } else {
        const file = this.app.vault.getAbstractFileByPath(this.sessionNotePath)
        if (file instanceof TFile) await this.app.vault.modify(file, body)
      }
      // Keep the in-memory index in sync so this very session is searchable.
      this.tools.updateIndex(this.sessionNotePath, body)
    } catch (e) {
      console.error('voz-notas: failed to save session note', e)
    }
  }

  // Final flush + reset when a session ends cleanly.
  async endSessionNote() {
    if (this.flushTimer != null) window.clearTimeout(this.flushTimer)
    this.flushTimer = null
    await this.flushSessionNote()
    this.sessionLog = []
    this.sessionConsulted.clear()
    this.sessionStart = null
    this.sessionNotePath = null
  }

  // Click the orb: start a session if idle, otherwise mute/unmute.
  onOrbClick() {
    if (this.session) this.toggleMute()
    else void this.toggleVoice()
  }

  toggleMute() {
    if (!this.session) {
      new Notice(t('notice.startFirst'))
      return
    }
    const next = !this.session.isMuted()
    this.session.setMuted(next)
    this.getView()?.setMuted(next)
    this.updateStatusBar()
  }

  async toggleVoice() {
    if (this.session) {
      this.session.stop()
      this.session = null
      this.pendingEndSession = false
      if (this.endFallbackTimer != null) window.clearTimeout(this.endFallbackTimer)
      this.endFallbackTimer = null
      const view = this.getView()
      view?.stopLevelMeter()
      view?.setActive(false)
      this.updateStatusBar()
      new Notice(t('notice.ended'))
      await this.endSessionNote()
      return
    }
    if (!this.settings.apiKey) {
      new Notice(t('notice.setKey'))
      return
    }
    try {
      // Build the note index BEFORE connecting, so in-session search is pure in-memory.
      if (this.tools.indexSize() === 0) {
        new Notice(t('notice.preparing'))
        await this.tools.readVault()
      }
      // Fresh transcript for the new session.
      this.sessionLog = []
      this.sessionConsulted.clear()
      this.sessionStart = new Date()
      this.sessionNotePath = null
      const view = await this.activateView()
      view?.clear()
      view?.setConnecting()
      const token = await this.getEphemeralToken()
      this.session = await startVoiceSession((offerSdp) => this.postSdp(offerSdp, token), {
        instructions: await this.getInstructions(),
        tools: [
          SEARCH_NOTES_TOOL,
          FIND_BY_NAME_TOOL,
          LIST_FOLDERS_TOOL,
          LIST_FOLDER_TOOL,
          READ_NOTE_TOOL,
          OPEN_NOTE_TOOL,
          ACTIVE_NOTE_TOOL,
          GET_LINKS_TOOL,
          GET_OUTLINE_TOOL,
          LIST_TAGS_TOOL,
          FIND_BY_TAG_TOOL,
          CREATE_NOTE_TOOL,
          APPEND_NOTE_TOOL,
          INSERT_TEXT_TOOL,
          THINK_TOOL,
          REMEMBER_TOOL,
          END_SESSION_TOOL,
        ],
        onToolCall: (name, args) => this.handleToolCall(name, args),
        onEvent: (e) => this.onRealtimeEvent(e),
      })
      const liveView = this.getView()
      liveView?.setActive(true)
      liveView?.startLevelMeter(() => this.session?.getLevel() ?? 0)
      this.updateStatusBar()
      new Notice(t('notice.connected'))
    } catch (e) {
      console.error(e)
      const view = this.getView()
      view?.stopLevelMeter()
      view?.setActive(false)
      this.updateStatusBar()
      new Notice(t('notice.error', (e as Error).message))
    }
  }

  // Run a tool the model asked for. Session control (end_session) is handled
  // here — it belongs to THIS session, never to a tool executor (a remote
  // client must not be able to end the desktop's session). Everything else is
  // delegated to the ToolExecutor, the same seam the mobile relay will use.
  async handleToolCall(name: string, args: ToolArgs): Promise<string> {
    if (name === 'end_session') {
      // Don't close yet — let the model speak its goodbye first. We close when
      // its audio finishes playing (or after a fallback timeout).
      this.pendingEndSession = true
      this.endFallbackTimer = window.setTimeout(() => {
        if (this.session) void this.toggleVoice()
      }, 10000)
      return 'Closing after your goodbye.'
    }
    this.getView()?.addActivity(activityLabel(name, args))
    return this.tools.execute(name, args)
  }

  // Base instructions (in code) + the vault context from init_session — the
  // SAME bootstrap the mobile client requests through the relay, so both
  // sessions start from one source of truth (identity, folders, AGENTS.md).
  async getInstructions(): Promise<string> {
    return `${INSTRUCTIONS}\n\n${await this.tools.execute('init_session', {})}`
  }

  // Mint a short-lived ephemeral token using the user's key.
  // requestUrl runs from Obsidian's main process, so it bypasses browser CORS.
  async getEphemeralToken(): Promise<string> {
    const res = await requestUrl({
      url: 'https://api.openai.com/v1/realtime/client_secrets',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2.1-mini',
          audio: {
            input: { transcription: { model: 'whisper-1' } }, // so we can show what you said
            output: { voice: 'marin' },
          },
        },
      }),
    })
    const data = res.json as { value?: unknown }
    if (typeof data.value !== 'string') throw new Error('No session token in the OpenAI response.')
    return data.value
  }

  // Signaling: send our offer SDP, return OpenAI's answer SDP. (Obsidian-specific: requestUrl.)
  async postSdp(offerSdp: string, ephemeralToken: string): Promise<string> {
    const res = await requestUrl({
      url: 'https://api.openai.com/v1/realtime/calls',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ephemeralToken}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    })
    return res.text
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<VozNotasSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored)
    setLang(this.settings.language)
  }

  async saveSettings() {
    setLang(this.settings.language)
    await this.saveData(this.settings)
  }
}

class VozNotasSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: VozNotasPlugin,
  ) {
    super(app, plugin)
  }

  display() {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dd) => {
        dd.addOption('en', 'English')
          .addOption('es', 'Español')
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as Lang
            await this.plugin.saveSettings()
            this.plugin.getView()?.refreshLang()
            this.display() // redraw so this pane updates to the new language
          })
      })

    new Setting(containerEl)
      .setName(t('settings.assistantName.name'))
      .setDesc(t('settings.assistantName.desc'))
      .addText((text) => {
        text
          .setPlaceholder('Eco')
          .setValue(this.plugin.settings.assistantName)
          .onChange(async (value) => {
            this.plugin.settings.assistantName = value.trim() || 'Eco'
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName(t('settings.notesFolder.name'))
      .setDesc(t('settings.notesFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('Eco')
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value.trim() || 'Eco'
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName(t('settings.saveSessions.name'))
      .setDesc(t('settings.saveSessions.desc'))
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.saveSessions).onChange(async (value) => {
          this.plugin.settings.saveSessions = value
          await this.plugin.saveSettings()
        })
      })

    new Setting(containerEl)
      .setName(t('settings.remote.name'))
      .setDesc(t('settings.remote.desc'))
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.remoteEnabled).onChange(async (value) => {
          this.plugin.settings.remoteEnabled = value
          await this.plugin.saveSettings()
          if (value) this.plugin.startRemote()
          else this.plugin.stopRemote()
          this.display()
        })
      })

    if (this.plugin.settings.remoteEnabled) {
      new Setting(containerEl)
        .setName(t('settings.relayUrl.name'))
        .setDesc(t('settings.relayUrl.desc'))
        .addText((text) => {
          text
            .setPlaceholder('ws://localhost:8787')
            .setValue(this.plugin.settings.relayUrl)
            .onChange(async (value) => {
              this.plugin.settings.relayUrl = value.trim() || 'ws://localhost:8787'
              await this.plugin.saveSettings()
            })
        })

      new Setting(containerEl)
        .setName(t('settings.qr.name'))
        .setDesc(t('settings.qr.desc'))
        .addButton((btn) => {
          btn
            .setButtonText(t('settings.qr.button'))
            .setCta()
            .onClick(() => new PairingQrModal(this.app, this.plugin.pairingPayload()).open())
        })

      new Setting(containerEl)
        .setName(t('settings.pairingId.name'))
        .setDesc(t('settings.pairingId.desc'))
        .addButton((btn) => {
          btn.setButtonText(this.plugin.settings.remoteSessionId || '—').onClick(async () => {
            await navigator.clipboard.writeText(this.plugin.settings.remoteSessionId)
            new Notice(t('remote.copied'))
          })
        })
        .addExtraButton((btn) => {
          btn
            .setIcon('refresh-cw')
            .setTooltip('Regenerate')
            .onClick(async () => {
              // New id AND new secret: old phones are cut off together.
              this.plugin.settings.remoteSessionId = newSessionId()
              this.plugin.settings.remoteSecret = newSecret()
              await this.plugin.saveSettings()
              this.plugin.stopRemote()
              this.plugin.startRemote()
              this.display()
            })
        })
    }

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Stored locally in this vault. Only sent to OpenAI to start a session.')
      .addText((text) => {
        text.inputEl.type = 'password' // hide the key as you type
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Reasoning model')
      .setDesc('Stronger model used by the "think" tool for opinions and deep analysis.')
      .addText((text) => {
        text
          .setPlaceholder('gpt-5')
          .setValue(this.plugin.settings.reasoningModel)
          .onChange(async (value) => {
            this.plugin.settings.reasoningModel = value.trim() || 'gpt-5'
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Instructions file (AGENTS.md)')
      .setDesc("A markdown file in the vault whose content is merged into the assistant's instructions.")
      .addText((text) => {
        text
          .setPlaceholder('AGENTS.md')
          .setValue(this.plugin.settings.agentsFile)
          .onChange(async (value) => {
            this.plugin.settings.agentsFile = value.trim() || 'AGENTS.md'
            await this.plugin.saveSettings()
          })
      })
  }
}

// The pairing QR: scanned by the mobile app. Rendered locally (no network) —
// the payload holds the relay URL, the session id and the E2E secret.
class PairingQrModal extends Modal {
  constructor(app: App, private payload: string) {
    super(app)
  }

  async onOpen() {
    this.contentEl.addClass('vn-qr-modal')
    this.contentEl.createEl('h3', { text: t('qr.title') })
    const dataUrl = await QRCode.toDataURL(this.payload, { width: 300, margin: 1 })
    this.contentEl.createEl('img', { attr: { src: dataUrl, alt: 'voz-notas pairing QR' } })
    this.contentEl.createEl('p', { text: t('qr.hint'), cls: 'vn-qr-hint' })
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText(t('qr.copy')).onClick(async () => {
        await navigator.clipboard.writeText(this.payload)
        new Notice(t('remote.copied'))
      }),
    )
  }

  onClose() {
    this.contentEl.empty()
  }
}
