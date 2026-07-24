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

    this.transcriptEl = root.createDiv({ cls: 'vn-transcript' })

    this.consultedLabelEl = root.createDiv({ cls: 'vn-section-label' })
    this.filesEl = root.createDiv({ cls: 'vn-files' })

    this.refreshLang()
    this.applyPhase()
  }

  setActive(active: boolean) {
    if (active) {
      this.setPhase('live')
    } else {
      this.currentAssistant = null
      this.setPhase('idle')
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
    this.statusEl?.setText(t(`orb.${this.phase}`))
    this.stopEl?.toggleClass('is-visible', active)
    // When not being driven by the meter, drop the inline scale so the orb
    // rests (idle) or freezes (muted) instead of holding its last size.
    if (this.phase !== 'live' && this.phase !== 'connecting') this.orbEl.style.transform = ''
  }

  // Drive the orb's size from live audio loudness (max of mic + assistant).
  startLevelMeter(getLevel: () => number) {
    this.levelSource = getLevel
    if (this.raf != null) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const tick = () => {
      this.raf = requestAnimationFrame(tick)
      const driving = this.phase === 'live' || this.phase === 'connecting'
      if (!driving || !this.orbEl || reduce?.matches) return
      const lvl = this.levelSource ? this.levelSource() : 0
      this.smooth += (lvl - this.smooth) * 0.35 // ease toward the new level
      const idle = 0.035 * Math.sin(performance.now() / 520) // gentle baseline breathing
      const s = 1 + idle + this.smooth * 0.45
      this.orbEl.style.transform = `scale(${s.toFixed(3)})`
    }
    this.raf = requestAnimationFrame(tick)
  }

  stopLevelMeter() {
    if (this.raf != null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.levelSource = null
    this.smooth = 0
    if (this.orbEl) this.orbEl.style.transform = ''
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
      this.currentAssistant = this.transcriptEl.createDiv({ cls: 'vn-turn vn-assistant' })
    }
    this.currentAssistant.setText(this.currentAssistant.getText() + delta)
    this.scroll()
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
  }

  private scroll() {
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight
  }

  async onClose() {
    this.stopLevelMeter()
  }
}
