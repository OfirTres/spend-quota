export type Snapshot =
  | { ok: true; spent: number; quota: number; at: number; isCached?: boolean }
  | { ok: false; reason: string; retryAfterMs?: number }

export type View = 'line' | 'report'

declare module 'claude-code' {
  interface PluginState {
    'spend-quota': { snapshot: Snapshot | null; shown: View | null }
  }
}
