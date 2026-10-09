export type Issue = {
  severity: 'error' | 'warning'
  file: string | null
  line: number | null
  column: number | null
  /** The compiler's or linter's own code for it: `TS2322`, `E0308`, `no-unused-vars`. */
  code: string | null
  message: string
}

export type TestFailure = {
  name: string
  message: string
  file: string | null
  line: number | null
}

export type Tests = {
  total: number
  passed: number
  failed: number
  skipped: number
  failures: TestFailure[]
}

export type Run = {
  id: string
  /** What ran, as the pane names it: `tsc`, `cargo test`, `npm run build`. */
  label: string
  kind: 'build' | 'test' | 'lint'
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: number
  durationMs: number | null
  errorCount: number
  warningCount: number
  issues: Issue[]
  tests: Tests | null
  /** Where Claude Code kept the whole output, when it was too long for the result. */
  logPath: string | null
  logLines: number
  /** True when anything was read out of the output: a diagnostic, a test count or a verdict. */
  hasFindings: boolean
  isCondensed: boolean
  /** Characters of output Claude did not have to read. */
  savedChars: number
}

declare module 'claude-code' {
  interface PluginState {
    'buildpane': {
      runs: Run[]
      isShowingWarnings: boolean
      now: number
      /** Characters of raw output replaced by summaries in this session. */
      savedChars: number
      /** The same, over every session before this one. */
      savedBefore: number
    }
  }
}
