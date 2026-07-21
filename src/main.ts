import { App, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian'
import { startVoiceSession, type VoiceSession, type ToolDef } from './core/voice'
import { searchNotes, type Note } from './core/retrieval'

interface VozNotasSettings {
  apiKey: string
}

const DEFAULT_SETTINGS: VozNotasSettings = {
  apiKey: '',
}

const INSTRUCTIONS = `You are a helpful voice assistant with access to the user's personal Obsidian notes (Markdown files that may link to each other with [[wikilinks]] and use #tags). When the user asks something that could be in their notes, call the search_notes tool, then answer based on the excerpts it returns — in ONE or TWO short sentences. Summarize; never read notes verbatim. If nothing relevant is found, say so briefly. Respond in the user's language.`

const SEARCH_NOTES_TOOL: ToolDef = {
  type: 'function',
  name: 'search_notes',
  description: "Search the user's Obsidian notes and return relevant excerpts.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for in the notes.' },
    },
    required: ['query'],
  },
}

export default class VozNotasPlugin extends Plugin {
  settings!: VozNotasSettings // set in onload() via loadSettings()
  session: VoiceSession | null = null
  notesCache: Note[] | null = null

  async onload() {
    await this.loadSettings()

    // Register the settings pane (where the API key lives).
    this.addSettingTab(new VozNotasSettingTab(this.app, this))

    // Click the mic to start a voice session; click again to stop.
    this.addRibbonIcon('mic', 'voz-notas', () => this.toggleVoice())

    // Mute/unmute your mic during a session (so the model can answer uninterrupted).
    this.addRibbonIcon('mic-off', 'voz-notas: mute/unmute', () => this.toggleMute())
    this.addCommand({
      id: 'toggle-mute',
      name: 'Toggle mute',
      callback: () => this.toggleMute(),
    })

    // Warm the notes cache once the vault is ready. (onload runs before the file
    // list is populated, which would cache an empty vault.)
    this.app.workspace.onLayoutReady(() => void this.readVault())
  }

  onunload() {
    this.session?.stop()
    this.session = null
  }

  toggleMute() {
    if (!this.session) {
      new Notice('Start a voice session first.')
      return
    }
    const next = !this.session.isMuted()
    this.session.setMuted(next)
    new Notice(next ? 'Muted 🔇' : 'Unmuted 🎙️')
  }

  async toggleVoice() {
    if (this.session) {
      this.session.stop()
      this.session = null
      new Notice('Voice session ended.')
      return
    }
    if (!this.settings.apiKey) {
      new Notice('Set your OpenAI API key in voz-notas settings first.')
      return
    }
    try {
      new Notice('Connecting…')
      const token = await this.getEphemeralToken()
      this.session = await startVoiceSession((offerSdp) => this.postSdp(offerSdp, token), {
        instructions: INSTRUCTIONS,
        tools: [SEARCH_NOTES_TOOL],
        onToolCall: (name, args) => this.handleToolCall(name, args),
      })
      new Notice('Connected — talk to your notes!')
    } catch (e) {
      console.error(e)
      new Notice('Voice error: ' + (e as Error).message)
    }
  }

  // Run a tool the model asked for, and return its result as a string.
  async handleToolCall(name: string, args: any): Promise<string> {
    console.log('tool call:', name, args)
    if (name === 'search_notes') {
      const notes = await this.readVault()
      const hits = searchNotes(notes, String(args?.query ?? ''), 3)
      if (hits.length === 0) return 'No matching notes found.'
      return hits.map((h) => `Note: ${h.path}\n${h.snippet}`).join('\n\n---\n\n')
    }
    return `Unknown tool: ${name}`
  }

  // Read all Markdown notes from the vault, cached and in parallel. (Obsidian-specific.)
  async readVault(): Promise<Note[]> {
    if (this.notesCache && this.notesCache.length > 0) return this.notesCache
    const t0 = Date.now()
    const files = this.app.vault.getMarkdownFiles()
    const notes = await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: await this.app.vault.cachedRead(file),
      })),
    )
    this.notesCache = notes
    console.log(`voz-notas: read ${notes.length} notes in ${Date.now() - t0}ms`)
    return notes
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
          audio: { output: { voice: 'marin' } },
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
  }

  async saveSettings() {
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
  }
}
