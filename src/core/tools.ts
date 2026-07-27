import type { ToolArgs } from './voice'

// The common seam between a voice session and whatever executes its tools.
// Implementations:
//  - VaultToolExecutor (desktop): runs tools against the local Obsidian vault.
//  - RelayToolExecutor (mobile, future): serializes the call, sends it over the
//    pairing relay to the desktop, and awaits the result.
// Tools speak plain JSON in and a string out, so the contract is transport-safe.
export interface ToolExecutor {
  execute(name: string, args: ToolArgs): Promise<string>
}
