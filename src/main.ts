import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, prepareFuzzySearch, requestUrl } from 'obsidian'
import { startVoiceSession, type VoiceSession, type ToolDef } from './core/voice'
import { snippetAround, type Note } from './core/retrieval'
import { VozNotasView, VIEW_TYPE } from './view'
import { t, setLang, type Lang } from './i18n'

interface VozNotasSettings {
  apiKey: string
  reasoningModel: string
  agentsFile: string
  language: Lang
  saveSessions: boolean
  assistantName: string
}

const DEFAULT_SETTINGS: VozNotasSettings = {
  apiKey: '',
  reasoningModel: 'gpt-5',
  agentsFile: 'AGENTS.md',
  language: 'en',
  saveSessions: true,
  assistantName: 'Eco',
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
- Past sessions are saved as notes under "voz-notas/sessions" — when the user refers to an earlier conversation ("what did we talk about yesterday?"), search or list that folder.
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

const NEW_NOTES_FOLDER = 'voz-notas'
// Session transcripts live in the vault → search_notes indexes them → the
// assistant gets memory of past conversations for free.
const SESSIONS_FOLDER = 'voz-notas/sessions'

export default class VozNotasPlugin extends Plugin {
  settings!: VozNotasSettings // set in onload() via loadSettings()
  session: VoiceSession | null = null
  notesCache: Note[] | null = null
  notesReadPromise: Promise<Note[]> | null = null
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

  async onload() {
    await this.loadSettings()

    // Register the settings pane (where the API key lives).
    this.addSettingTab(new VozNotasSettingTab(this.app, this))

    // Click the mic to start a voice session; click again to stop.
    // (Mute lives on the orb inside the panel — click it to mute/unmute.)
    this.addRibbonIcon('mic', 'voz-notas', () => this.toggleVoice())
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

    // Warm the notes cache once the vault is ready. (onload runs before the file
    // list is populated, which would cache an empty vault.)
    this.app.workspace.onLayoutReady(() => void this.readVault())
  }

  onunload() {
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

  async activateView(): Promise<VozNotasView> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)
      await leaf?.setViewState({ type: VIEW_TYPE, active: true })
    }
    if (leaf) this.app.workspace.revealLeaf(leaf)
    return leaf?.view as VozNotasView
  }

  // Route realtime events to the session log (memory) and the panel (UI).
  onRealtimeEvent(event: any) {
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
        if (event.item?.role === 'user' && event.item?.id) {
          if (!this.sessionLog.some((e) => e.id === event.item.id)) {
            this.sessionLog.push({ role: 'user', id: event.item.id, text: '' })
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
        view.fillUser(event.item_id, event.transcript ?? '')
        break
    }
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
        if (!this.app.vault.getAbstractFileByPath(SESSIONS_FOLDER)) {
          await this.app.vault.createFolder(SESSIONS_FOLDER).catch(() => {})
        }
        let path = `${SESSIONS_FOLDER}/${day} ${time}.md`
        let n = 1
        while (this.app.vault.getAbstractFileByPath(path)) path = `${SESSIONS_FOLDER}/${day} ${time} (${++n}).md`
        await this.app.vault.create(path, body)
        this.sessionNotePath = path
      } else {
        const file = this.app.vault.getAbstractFileByPath(this.sessionNotePath)
        if (file instanceof TFile) await this.app.vault.modify(file, body)
      }
      // Keep the in-memory index in sync so this very session is searchable.
      if (this.notesCache) {
        const cached = this.notesCache.find((note) => note.path === this.sessionNotePath)
        if (cached) cached.content = body
        else this.notesCache.push({ path: this.sessionNotePath, content: body })
      }
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
      if (!this.notesCache || this.notesCache.length === 0) {
        new Notice(t('notice.preparing'))
        await this.readVault()
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
      new Notice(t('notice.connected'))
    } catch (e) {
      console.error(e)
      const view = this.getView()
      view?.stopLevelMeter()
      view?.setActive(false)
      new Notice(t('notice.error', (e as Error).message))
    }
  }

  // Run a tool the model asked for, and return its result as a string.
  async handleToolCall(name: string, args: any): Promise<string> {
    console.log('tool call:', name, args)
    if (name === 'end_session') {
      // Don't close yet — let the model speak its goodbye first. We close when
      // its audio finishes playing (or after a fallback timeout).
      this.pendingEndSession = true
      this.endFallbackTimer = window.setTimeout(() => {
        if (this.session) void this.toggleVoice()
      }, 10000)
      return 'Closing after your goodbye.'
    }
    if (name === 'search_notes') {
      const hits = this.searchNotes(String(args?.query ?? ''), 5)
      hits.forEach((h) => this.noteConsulted(h.path))
      if (hits.length > 0) return hits.map((h) => `Note: ${h.path}\n${h.snippet}`).join('\n\n---\n\n')
      return this.notesCache?.length ? 'No matching notes found.' : 'Notes are still loading.'
    }
    if (name === 'read_note') {
      const p = String(args?.path ?? '')
      this.noteConsulted(p)
      const content = await this.readNote(p)
      return content ?? 'Note not found.'
    }
    if (name === 'open_note') {
      const p = String(args?.path ?? '')
      const opened = await this.openNote(p)
      if (opened) this.noteConsulted(p)
      return opened ? 'Opened it.' : 'Note not found.'
    }
    if (name === 'get_active_note') {
      const file = this.app.workspace.getActiveFile()
      if (!file) return 'No note is open.'
      this.noteConsulted(file.path)
      const content = (await this.app.vault.cachedRead(file)).slice(0, 6000)
      return `Path: ${file.path}\n\n${content}`
    }
    if (name === 'find_note_by_name') {
      const paths = this.findNotesByName(String(args?.name ?? ''), 8)
      return paths.length ? paths.join('\n') : 'No notes with that name.'
    }
    if (name === 'list_folders') {
      const folders = this.listFolders(String(args?.query ?? ''), 30)
      return folders.length ? folders.join('\n') : 'No folders found.'
    }
    if (name === 'list_folder') {
      const paths = this.listFolder(String(args?.folder ?? ''), 50)
      return paths.length ? paths.join('\n') : 'No notes in that folder.'
    }
    if (name === 'get_links') return this.getLinks(String(args?.path ?? ''))
    if (name === 'get_outline') return this.getOutline(String(args?.path ?? ''))
    if (name === 'list_tags') return this.listTags()
    if (name === 'find_notes_by_tag') {
      const paths = this.findNotesByTag(String(args?.tag ?? ''), 20)
      return paths.length ? paths.join('\n') : 'No notes with that tag.'
    }
    if (name === 'insert_text') {
      const ok = this.insertText(String(args?.text ?? ''))
      return ok ? 'Inserted it.' : 'No editor is active (open a note first).'
    }
    if (name === 'think') {
      const paths = Array.isArray(args?.paths) ? (args.paths as string[]) : []
      return await this.think(String(args?.question ?? ''), paths)
    }
    if (name === 'remember_rule') {
      return await this.rememberRule(String(args?.rule ?? ''))
    }
    if (name === 'create_note') {
      const path = await this.createNote(String(args?.title ?? ''), String(args?.content ?? ''))
      return path ? `Created ${path}.` : 'Could not create the note.'
    }
    if (name === 'append_to_note') {
      const ok = await this.appendToActiveNote(String(args?.text ?? ''))
      return ok ? 'Added it to the open note.' : 'No note is open to append to.'
    }
    return `Unknown tool: ${name}`
  }

  // Create a new note in the fixed folder. Non-destructive: never overwrites an existing note.
  async createNote(title: string, content: string): Promise<string | null> {
    if (!this.app.vault.getAbstractFileByPath(NEW_NOTES_FOLDER)) {
      await this.app.vault.createFolder(NEW_NOTES_FOLDER).catch(() => {})
    }
    const safe = (title || 'Untitled').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Untitled'
    let path = `${NEW_NOTES_FOLDER}/${safe}.md`
    let n = 1
    while (this.app.vault.getAbstractFileByPath(path)) path = `${NEW_NOTES_FOLDER}/${safe} ${++n}.md`
    const file = await this.app.vault.create(path, content)
    await this.app.workspace.getLeaf(false).openFile(file) // open the new note
    return file.path
  }

  // Append text to the note the user currently has open. Non-destructive.
  async appendToActiveNote(text: string): Promise<boolean> {
    const file = this.app.workspace.getActiveFile()
    if (!file) return false
    await this.app.vault.append(file, `\n${text}\n`)
    return true
  }

  // --- B: structure / graph (metadataCache — in memory, no disk reads) ---
  getLinks(path: string): string {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return 'Note not found.'
    const outgoing = (this.app.metadataCache.getFileCache(file)?.links ?? []).map((l) => l.link)
    const backlinks: string[] = []
    for (const [src, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (targets[file.path]) backlinks.push(src)
    }
    return `Outgoing: ${outgoing.join(', ') || 'none'}\nBacklinks: ${backlinks.join(', ') || 'none'}`
  }

  getOutline(path: string): string {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return 'Note not found.'
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? []
    return headings.length ? headings.map((h) => `${'#'.repeat(h.level)} ${h.heading}`).join('\n') : 'No headings.'
  }

  listTags(): string {
    const set = new Set<string>()
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file)
      cache?.tags?.forEach((t) => set.add(t.tag))
      const fm = cache?.frontmatter?.tags
      if (Array.isArray(fm)) fm.forEach((t) => set.add('#' + String(t).replace(/^#/, '')))
    }
    return [...set].sort().join(', ') || 'No tags.'
  }

  findNotesByTag(tag: string, limit = 20): string[] {
    const want = '#' + tag.replace(/^#/, '').toLowerCase()
    const out: string[] = []
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file)
      const tags = (cache?.tags ?? []).map((t) => t.tag.toLowerCase())
      const fm = cache?.frontmatter?.tags
      const fmTags = Array.isArray(fm) ? fm.map((t) => '#' + String(t).replace(/^#/, '').toLowerCase()) : []
      if (tags.includes(want) || fmTags.includes(want)) out.push(file.path)
      if (out.length >= limit) break
    }
    return out
  }

  // --- Editor: write at the cursor / replace the selection in the open note ---
  insertText(text: string): boolean {
    const editor = this.app.workspace.activeEditor?.editor
    if (!editor) return false
    editor.replaceSelection(text) // inserts at the cursor, or replaces the current selection
    return true
  }

  // --- Delegate deep reasoning to a stronger model over the given notes (BYOK, same key) ---
  async think(question: string, paths: string[]): Promise<string> {
    const chunks: string[] = []
    for (const p of paths.slice(0, 6)) {
      const file = this.app.vault.getAbstractFileByPath(p)
      if (file instanceof TFile) {
        const content = (await this.app.vault.cachedRead(file)).slice(0, 3000)
        chunks.push(`# ${p}\n${content}`)
      }
    }
    const context = chunks.length ? chunks.join('\n\n---\n\n') : '(no notes provided)'
    try {
      const res = await requestUrl({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.settings.reasoningModel || 'gpt-5',
          messages: [
            {
              role: 'system',
              content:
                "You are a sharp, thoughtful analyst of the user's personal notes. Give a well-reasoned, concise answer or opinion grounded in the provided notes. Be direct and honest.",
            },
            { role: 'user', content: `Notes:\n${context}\n\nQuestion: ${question}` },
          ],
        }),
      })
      const answer = res.json?.choices?.[0]?.message?.content
      return typeof answer === 'string' && answer.trim() ? answer : 'Could not get a reasoned answer.'
    } catch (e) {
      console.error('think error:', e)
      return 'The reasoning model failed: ' + (e as Error).message
    }
  }

  // Read one note's full content (capped so a huge note doesn't flood the model).
  async readNote(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return null
    const content = await this.app.vault.cachedRead(file)
    return content.slice(0, 6000)
  }

  // Open a note in the active pane so the user sees it. (An action on Obsidian.)
  async openNote(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return false
    await this.app.workspace.getLeaf(false).openFile(file)
    return true
  }

  // Find notes by filename/title with Obsidian's fuzzy matcher (fast: short strings, no reads).
  findNotesByName(query: string, limit = 8): string[] {
    const q = query.trim()
    if (!q) return []
    const match = prepareFuzzySearch(q)
    const scored: { path: string; score: number }[] = []
    for (const file of this.app.vault.getMarkdownFiles()) {
      const res = match(file.basename) ?? match(file.path)
      if (res) scored.push({ path: file.path, score: res.score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.path)
  }

  // List the markdown notes inside a folder path.
  listFolder(folder: string, limit = 50): string[] {
    const prefix = folder.replace(/\/+$/, '') + '/'
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix))
      .slice(0, limit)
      .map((f) => f.path)
  }

  // List/find folders (derived from note paths), optionally filtered by name (fuzzy).
  listFolders(query = '', limit = 30): string[] {
    const folders = new Set<string>()
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parts = file.path.split('/')
      parts.pop() // drop the filename
      let acc = ''
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part
        folders.add(acc)
      }
    }
    let list = [...folders]
    const q = query.trim()
    if (q) {
      const match = prepareFuzzySearch(q)
      list = list
        .map((path) => ({ path, res: match(path) }))
        .filter((x) => x.res)
        .sort((a, b) => b.res!.score - a.res!.score)
        .map((x) => x.path)
    } else {
      list.sort()
    }
    return list.slice(0, limit)
  }

  // Synchronous, in-memory keyword search over the pre-built cache. Instant, no I/O.
  searchNotes(query: string, limit = 3): { path: string; snippet: string }[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const notes = this.notesCache ?? []
    if (terms.length === 0 || notes.length === 0) return []
    const t0 = Date.now()
    const scored: { note: Note; score: number; at: number }[] = []
    for (const note of notes) {
      const lower = note.content.toLowerCase()
      let score = 0
      let at = -1
      for (const term of terms) {
        const idx = lower.indexOf(term)
        if (idx >= 0) {
          score++
          if (at < 0 || idx < at) at = idx
        }
      }
      if (score > 0) scored.push({ note, score, at: at < 0 ? 0 : at })
    }
    scored.sort((a, b) => b.score - a.score) // more matched terms = better
    console.log(`search: ${scored.length} matches in ${Date.now() - t0}ms`)
    return scored.slice(0, limit).map(({ note, at }) => ({
      path: note.path,
      snippet: snippetAround(note.content, at),
    }))
  }

  // Read all Markdown notes from the vault, cached and in parallel. (Obsidian-specific.)
  // Dedups concurrent reads: callers share one in-flight read instead of starting more.
  async readVault(): Promise<Note[]> {
    if (this.notesCache && this.notesCache.length > 0) return this.notesCache
    if (this.notesReadPromise) return this.notesReadPromise
    this.notesReadPromise = (async () => {
      const t0 = Date.now()
      const files = this.app.vault.getMarkdownFiles()
      const notes = await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await this.app.vault.cachedRead(file),
        })),
      )
      this.notesCache = notes
      this.notesReadPromise = null
      console.log(`voz-notas: read ${notes.length} notes in ${Date.now() - t0}ms`)
      return notes
    })()
    return this.notesReadPromise
  }

  // Persist a behaviour rule to the AGENTS.md (self-maintaining instructions).
  async rememberRule(rule: string): Promise<string> {
    const clean = rule.trim()
    if (!clean) return 'Empty rule.'
    const path = this.settings.agentsFile?.trim() || 'AGENTS.md'
    let file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      file = await this.app.vault.create(path, '# Assistant instructions\n')
    }
    const current = await this.app.vault.cachedRead(file as TFile)
    if (current.toLowerCase().includes(clean.toLowerCase())) return 'Already remembered.'
    const marker = '## Learned preferences'
    let next = current.includes(marker) ? current : `${current.trimEnd()}\n\n${marker}\n`
    next = `${next.trimEnd()}\n- ${clean}\n`
    await this.app.vault.modify(file as TFile, next)
    return 'Remembered — it will apply next session.'
  }

  // Merge the base instructions (in code) with the user's AGENTS.md from the vault, if present.
  async getInstructions(): Promise<string> {
    // Default spoken language = the settings language; the user can still switch
    // mid-conversation just by speaking another language.
    const lang = this.settings.language === 'es' ? 'Spanish' : 'English'
    const name = this.settings.assistantName?.trim() || 'Eco'
    const langLine = `Your name is ${name} — that's what the user calls you. Speak ${lang} by default. If the user speaks another language, switch to it.`
    const base = `${INSTRUCTIONS}\n\n${langLine}`

    const path = this.settings.agentsFile?.trim() || 'AGENTS.md'
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) {
      const userInstructions = (await this.app.vault.cachedRead(file)).trim()
      if (userInstructions) {
        return `${base}\n\n--- User instructions (from ${path}) ---\n${userInstructions}`
      }
    }
    return base
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
    return res.json.value
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
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
      .setName(t('settings.saveSessions.name'))
      .setDesc(t('settings.saveSessions.desc'))
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.saveSessions).onChange(async (value) => {
          this.plugin.settings.saveSessions = value
          await this.plugin.saveSettings()
        })
      })

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
