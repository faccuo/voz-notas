export interface Note {
  path: string
  content: string
}

// Extract a ~400-char window around a match index, to give the model context.
export function snippetAround(content: string, index: number, len = 400): string {
  const start = Math.max(0, index - 80)
  return content.slice(start, start + len).trim()
}
