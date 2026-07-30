import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian'
import type VozNotasPlugin from './main'
import { t } from './i18n'

type Phase = 'idle' | 'connecting' | 'live' | 'muted'

export const VIEW_TYPE = 'voz-notas-view'

// The right-sidebar panel: a voice orb, the live transcript (both sides),
// and the notes the assistant has consulted (clickable).
export class VozNotasView extends ItemView {
  private plugin: VozNotasPlugin
  private orbEl!: HTMLElement
  private statusEl!: HTMLElement
  private stopEl!: HTMLElement
  private consultedLabelEl!: HTMLElement
  private transcriptEl!: HTMLElement
  private filesEl!: HTMLElement
  private currentAssistant: HTMLElement | null = null
  private activityEl: HTMLElement | null = null
  private trialEl: HTMLElement | null = null
  private consulted = new Set<string>()
  private pendingUser = new Map<string, HTMLElement>()
  private phase: Phase = 'idle'
  private raf: number | null = null
  private levelSource: (() => number) | null = null
  private smooth = 0

  constructor(leaf: WorkspaceLeaf, plugin: VozNotasPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  getViewType() {
    return VIEW_TYPE
  }
  getDisplayText() {
    return 'voz-notas'
  }
  getIcon() {
    return 'mic'
  }

  async onOpen() {
    const root = this.contentEl
    root.empty()
    root.addClass('vn-panel')
    // Reset per-view state so onOpen is idempotent (Obsidian can re-run it,
    // e.g. when a leaf is moved) — the DOM above was just wiped.
    this.consulted.clear()
    this.pendingUser.clear()
    this.currentAssistant = null

    const orbWrap = root.createDiv({ cls: 'vn-orbwrap' })
    this.orbEl = orbWrap.createDiv({ cls: 'vn-orb' })
    // Muted badge (a crossed-out mic), shown only while muted.
    const badge = this.orbEl.createDiv({ cls: 'vn-orb-badge' })
    setIcon(badge, 'mic-off')
    // Click the orb to start a session, or mute/unmute while live.
    this.orbEl.onClickEvent(() => this.plugin.onOrbClick())
    // Status line under the orb ("Press to connect", "Listening…", "Muted…"),
    // with a hang-up button beside it (the orb click is taken by mute).
    const statusRow = orbWrap.createDiv({ cls: 'vn-statusrow' })
    this.statusEl = statusRow.createDiv({ cls: 'vn-status' })
    this.stopEl = statusRow.createEl('button', { cls: 'vn-stop' })
    setIcon(this.stopEl, 'phone-off')
    this.stopEl.onClickEvent(() => void this.plugin.toggleVoice())

    // Pair-a-phone shortcut: the QR modal, right where the user already is.
    const pairBtn = statusRow.createEl('button', { cls: 'vn-stop vn-pair' })
    setIcon(pairBtn, 'qr-code')
    pairBtn.setAttr('aria-label', t('settings.qr.name'))
    pairBtn.setAttr('title', t('settings.qr.name'))
    pairBtn.onClickEvent(() => this.plugin.showPairingQr())

    this.transcriptEl = root.createDiv({ cls: 'vn-transcript' })

    this.consultedLabelEl = root.createDiv({ cls: 'vn-section-label' })
    this.filesEl = root.createDiv({ cls: 'vn-files' })

    // Trial counter (only shown for trial credentials): what's left, always
    // in sight — not buried in settings.
    this.trialEl = root.createDiv({ cls: 'vn-trial' })
    void this.refreshTrialCounter()

    this.refreshLang()
    this.applyPhase()
    this.syncFromPlugin()
  }

  async refreshTrialCounter() {
    if (!this.trialEl) return
    const text = await this.plugin.trialCounterText()
    this.trialEl.setText(text ?? '')
    this.trialEl.toggleClass('is-hidden', !text)
  }

  // The call lives in the plugin, not in this panel — closing the panel never
  // hangs up. So when the panel (re)opens mid-session, rebuild the UI from the
  // plugin's state: full transcript, consulted notes, orb state.
  private syncFromPlugin() {
    const plugin = this.plugin
    if (!plugin.session) return
    for (const turn of plugin.sessionLog) {
      if (turn.role === 'user') {
        if (turn.text) this.transcriptEl.createDiv({ cls: 'vn-turn vn-user', text: turn.text })
        else if (turn.id) this.addUserPlaceholder(turn.id)
      } else if (turn.text) {
        this.appendAssistant(turn.text)
        this.finishAssistant()
      }
    }
    plugin.sessionConsulted.forEach((p) => this.addConsulted(p))
    this.setActive(true)
    if (plugin.session.isMuted()) this.setMuted(true)
    this.startLevelMeter(() => plugin.session?.getLevel() ?? 0)
    this.scroll()
  }

  setActive(active: boolean) {
    if (active) {
      this.setPhase('live')
    } else {
      this.currentAssistant = null
      this.setPhase('idle')
      // A session just ended — the trial counter (if any) moved.
      void this.refreshTrialCounter()
    }
  }

  setConnecting() {
    this.setPhase('connecting')
  }

  setMuted(muted: boolean) {
    this.setPhase(muted ? 'muted' : 'live')
  }

  private setPhase(phase: Phase) {
    this.phase = phase
    this.applyPhase()
  }

  private applyPhase() {
    if (!this.orbEl) return
    const active = this.phase !== 'idle'
    this.orbEl.toggleClass('is-active', active)
    this.orbEl.toggleClass('is-muted', this.phase === 'muted')
    const unconfigured = this.phase === 'idle' && !this.plugin.isConfigured()
    this.statusEl?.setText(t(unconfigured ? 'orb.unconfigured' : `orb.${this.phase}`))
    this.stopEl?.toggleClass('is-visible', active)
    // When not being driven by the meter, drop the inline scale so the orb
    // rests (idle) or freezes (muted) instead of holding its last size.
    if (this.phase !== 'live' && this.phase !== 'connecting') this.orbEl.setCssStyles({ transform: '' })
  }

  // Drive the orb's size from live audio loudness (max of mic + assistant).
  startLevelMeter(getLevel: () => number) {
    this.levelSource = getLevel
    if (this.raf != null) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const tick = () => {
      this.raf = window.requestAnimationFrame(tick)
      const driving = this.phase === 'live' || this.phase === 'connecting'
      if (!driving || !this.orbEl || reduce?.matches) return
      const lvl = this.levelSource ? this.levelSource() : 0
      this.smooth += (lvl - this.smooth) * 0.35 // ease toward the new level
      const idle = 0.035 * Math.sin(performance.now() / 520) // gentle baseline breathing
      const s = 1 + idle + this.smooth * 0.45
      this.orbEl.setCssStyles({ transform: `scale(${s.toFixed(3)})` })
    }
    this.raf = window.requestAnimationFrame(tick)
  }

  stopLevelMeter() {
    if (this.raf != null) window.cancelAnimationFrame(this.raf)
    this.raf = null
    this.levelSource = null
    this.smooth = 0
    if (this.orbEl) this.orbEl.setCssStyles({ transform: '' })
  }

  // Re-apply every user-facing string in the current language.
  refreshLang() {
    this.orbEl?.setAttr('aria-label', t('orb.aria'))
    this.stopEl?.setAttr('aria-label', t('orb.stop'))
    this.stopEl?.setAttr('title', t('orb.stop'))
    this.consultedLabelEl?.setText(t('panel.consulted'))
    this.applyPhase()
  }

  // Brief pulse of the orb (restart the animation each time there's voice activity).
  pulse() {
    if (!this.orbEl) return
    this.orbEl.removeClass('is-pulse')
    void this.orbEl.offsetWidth // force reflow so the animation replays
    this.orbEl.addClass('is-pulse')
  }

  // Reserve the user's turn as soon as they speak (before the assistant replies),
  // so the transcript stays in order even though transcription arrives later.
  addUserPlaceholder(id: string) {
    if (!id || this.pendingUser.has(id)) return
    this.currentAssistant = null
    const turn = this.transcriptEl.createDiv({ cls: 'vn-turn vn-user vn-pending', text: '…' })
    this.pendingUser.set(id, turn)
    this.scroll()
  }

  fillUser(id: string, text: string) {
    const t = text?.trim()
    const el = this.pendingUser.get(id)
    if (el) {
      el.setText(t || '…')
      el.removeClass('vn-pending')
      this.pendingUser.delete(id)
    } else if (t) {
      this.transcriptEl.createDiv({ cls: 'vn-turn vn-user', text: t })
    }
    this.scroll()
  }

  appendAssistant(delta: string) {
    if (!delta) return
    if (!this.currentAssistant) {
      // The answer is starting — the "Searching…" line has served its purpose.
      this.clearActivity()
      this.currentAssistant = this.transcriptEl.createDiv({ cls: 'vn-turn vn-assistant' })
    }
    this.currentAssistant.setText(this.currentAssistant.getText() + delta)
    this.scroll()
  }

  // Transient "what I'm doing" line (Searching… / Thinking…). One at a time:
  // a new activity replaces the previous, and the NEXT assistant bubble clears
  // it. Deliberately does not touch currentAssistant — the model often speaks
  // ("let me check…") in the same response that calls the tool, and resetting
  // it would split that utterance in two and wipe this line on the next delta.
  addActivity(text: string) {
    if (!text) return
    this.clearActivity()
    this.activityEl = this.transcriptEl.createDiv({ cls: 'vn-activity', text })
    this.scroll()
  }

  private clearActivity() {
    this.activityEl?.remove()
    this.activityEl = null
  }

  finishAssistant() {
    this.currentAssistant = null
  }

  addConsulted(path: string) {
    if (!path || this.consulted.has(path)) return
    this.consulted.add(path)
    const item = this.filesEl.createDiv({ cls: 'vn-file', text: path.split('/').pop() ?? path })
    item.setAttr('title', path)
    item.onClickEvent(() => this.app.workspace.openLinkText(path, '', false))
  }

  clear() {
    this.transcriptEl?.empty()
    this.filesEl?.empty()
    this.consulted.clear()
    this.pendingUser.clear()
    this.currentAssistant = null
    this.activityEl = null
  }

  private scroll() {
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight
  }

  async onClose() {
    this.stopLevelMeter()
  }
}
