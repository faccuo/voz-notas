import { App, TAbstractFile, TFile, prepareFuzzySearch, requestUrl } from 'obsidian'
import type { ToolExecutor } from './core/tools'
import type { ToolArgs } from './core/voice'
import { snippetAround, type Note } from './core/retrieval'

// The settings VaultToolExecutor needs, read live via a getter so changes in
// the settings pane apply without rewiring.
export interface VaultToolsSettings {
  apiKey: string
  reasoningModel: string
  agentsFile: string
  notesFolder: string
  language: string
  assistantName: string
  saveSessions: boolean
}

export interface VaultToolsConfig {
  app: App
  getSettings: () => VaultToolsSettings
  // Fired when a tool touches a note (search hit, read, open…) so the UI can list it.
  onConsulted?: (path: string) => void
}

// Runs the assistant's tools against the local Obsidian vault. This is the
// desktop implementation of ToolExecutor — the same calls the mobile app will
// send over the relay end up here, executed by this exact class.
export class VaultToolExecutor implements ToolExecutor {
  private app: App
  private getSettings: () => VaultToolsSettings
  private onConsulted?: (path: string) => void
  private notesCache: Note[] | null = null
  private notesReadPromise: Promise<Note[]> | null = null

  constructor(config: VaultToolsConfig) {
    this.app = config.app
    this.getSettings = config.getSettings
    this.onConsulted = config.onConsulted
  }

  async execute(name: string, args: ToolArgs): Promise<string> {
    if (name === 'search_notes') {
      const query = String(args?.query ?? '')
      const hits = this.searchNotes(query, 5)
      hits.forEach((h) => this.onConsulted?.(h.path))
      if (hits.length > 0) return hits.map((h) => `Note: ${h.path}\n${h.snippet}`).join('\n\n---\n\n')
      // Content search came up dry — fall back to filename matching over the
      // LIVE file list (never stale), so "read me X" works even for notes the
      // index somehow missed.
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const byName = this.app.vault
        .getMarkdownFiles()
        .filter((f) => terms.some((term) => f.basename.toLowerCase().includes(term)))
        .slice(0, 5)
      if (byName.length > 0) {
        byName.forEach((f) => this.onConsulted?.(f.path))
        return (
          'No content matches, but these note names match:\n' +
          byName.map((f) => `Note: ${f.path}`).join('\n')
        )
      }
      return this.notesCache?.length ? 'No matching notes found.' : 'Notes are still loading.'
    }
    if (name === 'read_note') {
      const p = String(args?.path ?? '')
      this.onConsulted?.(p)
      const content = await this.readNote(p)
      return content ?? 'Note not found.'
    }
    if (name === 'open_note') {
      const p = String(args?.path ?? '')
      const opened = await this.openNote(p)
      if (opened) this.onConsulted?.(p)
      return opened ? 'Opened it.' : 'Note not found.'
    }
    if (name === 'get_active_note') {
      const file = this.app.workspace.getActiveFile()
      if (!file) return 'No note is open.'
      this.onConsulted?.(file.path)
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
      const paths = Array.isArray(args?.paths) ? args.paths.map(String) : []
      return await this.think(String(args?.question ?? ''), paths)
    }
    if (name === 'remember_rule') {
      return await this.rememberRule(String(args?.rule ?? ''))
    }
    if (name === 'init_session') {
      return await this.initSession()
    }
    if (name === 'save_session') {
      // Service call from the mobile client (not a model tool): persist the
      // phone session transcript in the sessions folder. Incremental flushes
      // resend the whole markdown, so create-or-overwrite is idempotent.
      if (!this.getSettings().saveSessions) return 'Session saving is disabled in settings.'
      const title = String(args?.title ?? '').replace(/[\\/:*?"<>|]/g, ' ').trim()
      const markdown = String(args?.markdown ?? '')
      if (!title || !markdown) return 'Error: missing title or content.'
      await this.saveSessionNote(title, markdown)
      return 'Saved.'
    }
    if (name === 'create_note') {
      const path = await this.createNote(String(args?.title ?? ''), String(args?.content ?? ''))
      return path ? `Created ${path}.` : 'Could not create the note.'
    }
    if (name === 'append_to_note') {
      // With a path (the remote/mobile case) append to that note; without one
      // (the original desktop shape) append to whatever note is open.
      const path = String(args?.path ?? '')
      if (path) {
        const ok = await this.appendToNote(path, String(args?.text ?? ''))
        if (ok) this.onConsulted?.(path)
        return ok ? 'Added it.' : 'Note not found.'
      }
      const ok = await this.appendToActiveNote(String(args?.text ?? ''))
      return ok ? 'Added it to the open note.' : 'No note is open to append to.'
    }
    return `Unknown tool: ${name}`
  }

  // --- The note index (built once, searched synchronously in memory) ---

  // Read all Markdown notes from the vault, cached and in parallel.
  // Dedups concurrent reads: callers share one in-flight read instead of starting more.
  async readVault(): Promise<Note[]> {
    if (this.notesCache && this.notesCache.length > 0) return this.notesCache
    if (this.notesReadPromise) return this.notesReadPromise
    this.notesReadPromise = (async () => {
      const files = this.app.vault.getMarkdownFiles()
      const notes = await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await this.app.vault.cachedRead(file),
        })),
      )
      this.notesCache = notes
      this.notesReadPromise = null
      return notes
    })()
    return this.notesReadPromise
  }

  indexSize(): number {
    return this.notesCache?.length ?? 0
  }

  // Keep the in-memory index in sync when the plugin writes a note itself
  // (e.g. session transcripts), so it's searchable without a reload.
  updateIndex(path: string, content: string) {
    if (!this.notesCache) return
    const cached = this.notesCache.find((note) => note.path === path)
    if (cached) cached.content = content
    else this.notesCache.push({ path, content })
  }

  // Vault-event hooks (create/modify): re-read one file into the index, so
  // notes the assistant just created — or the user just edited — are
  // searchable immediately, without reloading the plugin.
  async refreshIndexFile(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== 'md') return
    if (!this.notesCache) return // initial vault read will pick it up
    this.updateIndex(file.path, await this.app.vault.cachedRead(file))
  }

  dropFromIndex(path: string) {
    if (this.notesCache) this.notesCache = this.notesCache.filter((note) => note.path !== path)
  }

  // Synchronous, in-memory keyword search over the pre-built cache. Instant, no I/O.
  searchNotes(query: string, limit = 3): { path: string; snippet: string }[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const notes = this.notesCache ?? []
    if (terms.length === 0 || notes.length === 0) return []
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
    return scored.slice(0, limit).map(({ note, at }) => ({
      path: note.path,
      snippet: snippetAround(note.content, at),
    }))
  }

  // --- Reading / navigation ---

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

  // --- Structure / graph (metadataCache — in memory, no disk reads) ---

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
      const fm: unknown = cache?.frontmatter?.tags
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
      const fm: unknown = cache?.frontmatter?.tags
      const fmTags = Array.isArray(fm) ? fm.map((t) => '#' + String(t).replace(/^#/, '').toLowerCase()) : []
      if (tags.includes(want) || fmTags.includes(want)) out.push(file.path)
      if (out.length >= limit) break
    }
    return out
  }

  // Everything a session needs to know about this vault at start — identity,
  // where things live, and the user's standing rules (AGENTS.md). Bootstrap
  // call, not a model tool: desktop and mobile both request it through the
  // executor seam when a session opens, so the phone inherits the exact same
  // context without being able to read the vault.
  async initSession(): Promise<string> {
    const s = this.getSettings()
    const name = s.assistantName?.trim() || 'Eco'
    const lang = s.language === 'es' ? 'Spanish' : 'English'
    const parts = [
      `Your name is ${name} — that's what the user calls you. Speak ${lang} by default. If the user speaks another language, switch to it.`,
      `New notes you create go in "${this.getNotesFolder()}". Past sessions are saved as notes under "${this.getNotesFolder()}/sessions" — when the user refers to an earlier conversation ("what did we talk about yesterday?"), search or list that folder.`,
    ]
    // Full read on purpose: readNote() caps at 6000 chars for model reads,
    // but standing rules must never be silently truncated.
    const path = s.agentsFile?.trim() || 'AGENTS.md'
    const file = this.app.vault.getAbstractFileByPath(path)
    const rules = file instanceof TFile ? (await this.app.vault.cachedRead(file)).trim() : ''
    if (rules) parts.push(`--- User instructions (from ${path}) ---\n${rules}`)
    return parts.join('\n\n')
  }

  // Create or overwrite a session note under "<notes>/sessions". Mirrors the
  // desktop's own session saving; used by save_session for mobile transcripts.
  async saveSessionNote(title: string, markdown: string): Promise<void> {
    const folder = `${this.getNotesFolder()}/sessions`
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {})
    }
    const path = `${folder}/${title}.md`
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) await this.app.vault.modify(existing, markdown)
    else await this.app.vault.create(path, markdown)
  }

  // --- Writing (all non-destructive; confirmation is enforced by the instructions) ---

  private getNotesFolder(): string {
    return this.getSettings().notesFolder?.trim().replace(/\/+$/, '') || 'Eco'
  }

  // Create a new note in the assistant folder. Never overwrites an existing note.
  async createNote(title: string, content: string): Promise<string | null> {
    if (!this.app.vault.getAbstractFileByPath(this.getNotesFolder())) {
      await this.app.vault.createFolder(this.getNotesFolder()).catch(() => {})
    }
    const safe = (title || 'Untitled').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Untitled'
    let path = `${this.getNotesFolder()}/${safe}.md`
    let n = 1
    while (this.app.vault.getAbstractFileByPath(path)) path = `${this.getNotesFolder()}/${safe} ${++n}.md`
    const file = await this.app.vault.create(path, content)
    await this.app.workspace.getLeaf(false).openFile(file) // open the new note
    return file.path
  }

  // Append text to a specific note by path. Non-destructive.
  async appendToNote(path: string, text: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return false
    await this.app.vault.append(file, `\n${text}\n`)
    return true
  }

  // Append text to the note the user currently has open. Non-destructive.
  async appendToActiveNote(text: string): Promise<boolean> {
    const file = this.app.workspace.getActiveFile()
    if (!file) return false
    await this.app.vault.append(file, `\n${text}\n`)
    return true
  }

  // Write at the cursor / replace the selection in the open note.
  insertText(text: string): boolean {
    const editor = this.app.workspace.activeEditor?.editor
    if (!editor) return false
    editor.replaceSelection(text) // inserts at the cursor, or replaces the current selection
    return true
  }

  // Persist a behaviour rule to the AGENTS.md (self-maintaining instructions).
  async rememberRule(rule: string): Promise<string> {
    const clean = rule.trim()
    if (!clean) return 'Empty rule.'
    const path = this.getSettings().agentsFile?.trim() || 'AGENTS.md'
    const existing = this.app.vault.getAbstractFileByPath(path)
    const file = existing instanceof TFile ? existing : await this.app.vault.create(path, '# Assistant instructions\n')
    const current = await this.app.vault.cachedRead(file)
    if (current.toLowerCase().includes(clean.toLowerCase())) return 'Already remembered.'
    const marker = '## Learned preferences'
    let next = current.includes(marker) ? current : `${current.trimEnd()}\n\n${marker}\n`
    next = `${next.trimEnd()}\n- ${clean}\n`
    await this.app.vault.modify(file, next)
    return 'Remembered — it will apply next session.'
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
          Authorization: `Bearer ${this.getSettings().apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.getSettings().reasoningModel || 'gpt-5',
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
      const data = res.json as { choices?: Array<{ message?: { content?: unknown } }> } | undefined
      const answer = data?.choices?.[0]?.message?.content
      return typeof answer === 'string' && answer.trim() ? answer : 'Could not get a reasoned answer.'
    } catch (e) {
      console.error('think error:', e)
      return 'The reasoning model failed: ' + (e as Error).message
    }
  }
}
