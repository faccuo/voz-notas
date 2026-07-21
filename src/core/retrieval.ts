// Simple keyword search over a set of notes. Agnostic to where notes come from.
// (Embeddings / vector search come later; this is the "make it work" version.)

export interface Note {
  path: string
  content: string
}

export interface SearchHit {
  path: string
  snippet: string
  score: number
}

export function searchNotes(notes: Note[], query: string, limit = 3): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: SearchHit[] = []

  for (const note of notes) {
    const lower = note.content.toLowerCase()

    // Score = how many distinct query terms appear in the note.
    let score = 0
    for (const term of terms) {
      if (lower.includes(term)) score++
    }
    if (score === 0) continue

    // Snippet: a ~300-char window around the first matching term.
    const firstTerm = terms.find((t) => lower.includes(t))!
    const idx = lower.indexOf(firstTerm)
    const start = Math.max(0, idx - 100)
    const snippet = note.content.slice(start, start + 300).trim()

    hits.push({ path: note.path, snippet, score })
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}
