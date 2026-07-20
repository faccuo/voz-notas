import { App, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian'
import { startVoiceSession, type VoiceSession } from './core/voice'

interface VozNotasSettings {
  apiKey: string
}

const DEFAULT_SETTINGS: VozNotasSettings = {
  apiKey: '',
}

export default class VozNotasPlugin extends Plugin {
  settings!: VozNotasSettings // set in onload() via loadSettings()
  session: VoiceSession | null = null

  async onload() {
    await this.loadSettings()

    // Register the settings pane (where the API key lives).
    this.addSettingTab(new VozNotasSettingTab(this.app, this))

    // Click the mic to start a voice session; click again to stop.
    this.addRibbonIcon('mic', 'voz-notas', () => this.toggleVoice())
  }

  onunload() {
    this.session?.stop()
    this.session = null
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
      this.session = await startVoiceSession((offerSdp) => this.postSdp(offerSdp, token))
      new Notice('Connected — talk!')
    } catch (e) {
      console.error(e)
      new Notice('Voice error: ' + (e as Error).message)
    }
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
