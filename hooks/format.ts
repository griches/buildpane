import type { Issue, Run } from '../types'

export type FileGroup = { file: string | null; issues: Issue[] }

export type CondenseSettings = {
  warnings: 'count' | 'list'
  exitCode: number | null
  /** Lines that mention a failure the rules did not read, added to a failed run's summary so none is lost. */
  tail: readonly string[]
  /** The tool the model can call for what the summary leaves out. */
  detailsTool: string
}

export type Detail = 'all' | 'errors' | 'warnings' | 'tests' | 'raw'

const LISTED = 50
const CHARS_PER_TOKEN = 4

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export const basename = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

export const seconds = (ms: number) => {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const whole = Math.round(ms / 1000)

  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

/** `about 12.4k tokens`: a count of characters as the tokens they roughly come to. */
export const tokens = (chars: number) => {
  const count = Math.round(chars / CHARS_PER_TOKEN)

  if (count < 1000) {
    return `${count}`
  }

  return count < 1_000_000 ? `${(count / 1000).toFixed(1)}k` : `${(count / 1_000_000).toFixed(2)}M`
}

const NOUN = { build: 'BUILD', test: 'TEST', lint: 'CHECK' } as const

/** `BUILD FAILED`, `TEST SUCCEEDED`, `CHECK FAILED`. */
export const verdict = (run: Run) => `${NOUN[run.kind]} ${run.status.toUpperCase()}`

/** `1 error · 3 warnings · 12 tests, 1 failed`. */
export const tally = (run: Run) => {
  const parts = [plural(run.errorCount, 'error'), plural(run.warningCount, 'warning')]

  if (run.tests !== null) {
    parts.push(`${plural(run.tests.total, 'test')}, ${run.tests.failed} failed`)
  }

  return parts.join(' · ')
}

export const location = (issue: Pick<Issue, 'line' | 'column'>) =>
  issue.line === null ? '' : issue.column === null ? `${issue.line}` : `${issue.line}:${issue.column}`

/** Issues grouped by file in the order the files first appear, errors before warnings within one. */
export const byFile = (issues: readonly Issue[]): FileGroup[] => {
  const groups = new Map<string | null, Issue[]>()

  for (const issue of issues) {
    groups.set(issue.file, [...(groups.get(issue.file) ?? []), issue])
  }

  return [...groups].map(([file, list]) => ({
    file,
    issues: [...list.filter(one => one.severity === 'error'), ...list.filter(one => one.severity === 'warning')],
  }))
}

const diagnostic = (issue: Issue) => {
  const where = [issue.file, location(issue)].filter(Boolean).join(':')
  const kind = issue.code === null ? issue.severity : `${issue.severity} ${issue.code}`

  return where === '' ? `${kind}: ${issue.message}` : `${where}: ${kind}: ${issue.message}`
}

const listed = (lines: readonly string[], total: number, word: string) =>
  total > lines.length ? [...lines, `(+${plural(total - lines.length, `more ${word}`)})`] : [...lines]

const failedTests = (run: Run, limit: number) =>
  (run.tests?.failures ?? []).slice(0, limit).map(failure => {
    const where = failure.file === null ? '' : ` (${[failure.file, failure.line].filter(one => one !== null).join(':')})`

    return failure.message === '' ? `  ${failure.name}${where}` : `  ${failure.name}: ${failure.message}${where}`
  })

/**
 * What Claude reads in place of the raw output: the verdict, every error with
 * its place, the failed tests, and the warnings counted or listed.
 */
export const condense = (run: Run, settings: CondenseSettings): string => {
  const errors = run.issues.filter(one => one.severity === 'error')
  const warnings = run.issues.filter(one => one.severity === 'warning')
  const took = run.durationMs === null ? '' : ` in ${seconds(run.durationMs)}`
  const exit = settings.exitCode === null ? '' : ` (exit code ${settings.exitCode})`
  const blocks: string[][] = [[`${run.label}: ${verdict(run)}${took}${exit}`, tally(run)]]

  if (errors.length > 0) {
    blocks.push(listed(errors.slice(0, LISTED).map(diagnostic), run.errorCount, 'error'))
  }

  if (run.tests !== null && run.tests.failures.length > 0) {
    blocks.push(['Failed tests:', ...listed(failedTests(run, LISTED), run.tests.failed, 'failed test')])
  }

  if (run.warningCount > 0 && settings.warnings === 'list') {
    blocks.push(listed(warnings.slice(0, LISTED).map(diagnostic), run.warningCount, 'warning'))
  } else if (run.warningCount > 0) {
    const files = byFile(warnings)
      .slice(0, 8)
      .map(group => `${group.file === null ? 'no file' : basename(group.file)} (${group.issues.length})`)
    blocks.push([`${plural(run.warningCount, 'warning')} not listed: ${files.join(', ')}. Call ${settings.detailsTool} to list them.`])
  }

  if (run.status === 'failed' && settings.tail.length > 0) {
    blocks.push(['Other lines that mention a failure:', ...settings.tail.map(line => `  ${line}`)])
  }

  const whole =
    run.logPath === null
      ? `Call ${settings.detailsTool} with show "raw" for the output itself.`
      : `Full output: ${run.logPath}`
  blocks.push([`[buildpane: summarised from ${plural(run.logLines, 'line')} of output. ${whole}]`])

  return blocks.map(block => block.join('\n')).join('\n\n')
}

/** A run in full, for the details tool: every stored error and warning with its place, and the failed tests. */
export const details = (run: Run, show: Exclude<Detail, 'raw'>): string => {
  const wants = (one: Detail) => show === 'all' || show === one
  const of = (severity: Issue['severity']) => run.issues.filter(one => one.severity === severity).map(diagnostic)
  const took = run.durationMs === null ? '' : ` in ${seconds(run.durationMs)}`
  const blocks: string[][] = [[`${run.label}: ${verdict(run)}${took}`, tally(run)]]

  if (wants('errors')) {
    blocks.push(run.errorCount === 0 ? ['No errors.'] : listed(of('error'), run.errorCount, 'error'))
  }

  if (wants('warnings')) {
    blocks.push(run.warningCount === 0 ? ['No warnings.'] : listed(of('warning'), run.warningCount, 'warning'))
  }

  if (wants('tests') && run.tests !== null) {
    const { tests } = run
    blocks.push([
      `${plural(tests.total, 'test')}: ${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped`,
      ...listed(failedTests(run, tests.failures.length), tests.failed, 'failed test'),
    ])
  } else if (show === 'tests') {
    blocks.push(['This run reported no tests.'])
  }

  return blocks.map(block => block.join('\n')).join('\n\n')
}
