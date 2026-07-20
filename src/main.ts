import { Plugin, Notice } from 'obsidian'

export default class VozNotasPlugin extends Plugin {
  // Obsidian calls this when the plugin is enabled. It's our entry point.
  async onload() {
    new Notice('voz-notas loaded 🎙️')

    // A ribbon icon in the left sidebar, to confirm we're alive.
    this.addRibbonIcon('mic', 'voz-notas', () => {
      new Notice('Hello from voz-notas!')
    })

    // And a command, reachable from the palette (Cmd/Ctrl+P).
    this.addCommand({
      id: 'hello',
      name: 'Say hello',
      callback: () => new Notice('Hello from voz-notas!'),
    })
  }

  onunload() {
    // Cleanup when the plugin is disabled. Nothing to do yet.
  }
}
