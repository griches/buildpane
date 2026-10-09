import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Issue, Run } from '../types'
import { findInvocations } from './detect'
import { basename, byFile, condense, details, location, plural, seconds, tally, tokens, verdict } from './format'
import type { Detail } from './format'
import { parse } from './parse'

const PANE = 'buildpane'
const TITLE = 'Build'
const COMMAND = 'buildpane'
const DETAILS_TOOL = 'mcp__buildpane__details'
const SAVED_KEY = 'savedChars'
const KEPT_RUNS = 20
const KEPT_ISSUES = 300
const KEPT_RAW = 5
const RAW_CHARS = 40_000
const PANE_ISSUES = 60
const ROW_ERRORS = 3
/** A summary has to be this much shorter than the output before it replaces it. */
const WORTH_IT = 0.7

type AutoOpen = 'always' | 'failure' | 'never'

const runs = atom({ plugin: 'buildpane', key: 'runs' } as const, [])
const isShowingWarnings = atom({ plugin: 'buildpane', key: 'isShowingWarnings' } as const, false)
const now = atom({ plugin: 'buildpane', key: 'now' } as const, 0)
const savedChars = atom({ plugin: 'buildpane', key: 'savedChars' } as const, 0)
const savedBefore = atom({ plugin: 'buildpane', key: 'savedBefore' } as const, 0)

const GLYPH = { running: '●', succeeded: '✓', failed: '✗', cancelled: '◌' } as const
const TONE = { running: 'warning', succeeded: 'success', failed: 'error', cancelled: undefined } as const

const isError = (issue: Issue) => issue.severity === 'error'

const openPane = ($: EngineInterface) => {
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

const store = ($: EngineInterface, run: Run) =>
  update($, runs, list => [...list.filter(one => one.id !== run.id), run].slice(-KEPT_RUNS))

const drop = ($: EngineInterface, id: string) => update($, runs, list => list.filter(one => one.id !== id))

/** Moves the pane's clock on, so a running timer redraws. */
const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
}

/** Shows `running` in the pane with a ticking timer for as long as `work` takes. */
const track = async <T,>($: EngineInterface, running: Run, autoOpen: AutoOpen, work: () => Promise<T>): Promise<T> => {
  await update($, now, () => running.startedAt)
  await store($, running)

  if (autoOpen === 'always') {
    openPane($)
  }

  const ticker = $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
  })

  try {
    return await work()
  } catch (error) {
    await drop($, running.id)
    throw error
  } finally {
    ticker.cancel()
  }
}

/** Stores a finished run and says how it went: the status line on a failure, a toast on a success. */
const announce = async ($: EngineInterface, finished: Run, autoOpen: AutoOpen) => {
  await store($, finished)

  if (finished.status === 'failed') {
    $.ui.status(`${GLYPH.failed} ${finished.label}: ${tally(finished)}`)

    if (autoOpen === 'failure') {
      openPane($)
    }
  } else {
    $.ui.status(undefined)
  }

  if (finished.status === 'succeeded' && finished.hasFindings) {
    $.ui.toast(`${GLYPH.succeeded} ${finished.label} · ${tally(finished)} · ${seconds(finished.durationMs ?? 0)}`)
  }
}

const sorted = (issues: readonly Issue[]) => [...issues.filter(isError), ...issues.filter(one => !isError(one))].slice(0, KEPT_ISSUES)

const textLength = (content: unknown): number => {
  if (typeof content === 'string') {
    return content.length
  }

  return Array.isArray(content)
    ? content.reduce((total: number, block: { text?: unknown }) => total + (typeof block.text === 'string' ? block.text.length : 0), 0)
    : 0
}

export const register: Register = (on, options) => {
  const wantsCondense = options.condense !== false
  const wantsCompactRow = options.compactRow !== false
  const warnings = options.warnings === 'list' ? 'list' : 'count'
  const autoOpen: AutoOpen = options.autoOpen === 'always' || options.autoOpen === 'never' ? options.autoOpen : 'failure'
  const condensed = new Map<string, string>()
  const raw = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the build pane: errors by file, warnings, failed tests, tokens saved (clear: forget the runs)',
    })
    await $.tool.register({
      name: 'details',
      description:
        'Lists what the most recent build, test run or lint run reported, in full: every error and warning with its file, line and message, and the failed tests. Call it when a summary counted warnings without listing them, or with show "raw" for the end of the output itself. It reads stored results and runs nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          show: {
            type: 'string',
            enum: ['all', 'errors', 'warnings', 'tests', 'raw'],
            description: 'Which part to list; all by default.',
          },
        },
      },
    })
    const before = Number((await $.store.get(SAVED_KEY).catch(() => 0)) ?? 0)
    await update($, savedBefore, () => (Number.isFinite(before) ? before : 0))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, runs, () => [])
      $.ui.status(undefined)

      return { text: 'Build history cleared.' }
    }

    await $.ui.open({ id: PANE, title: TITLE })
    const latest = (await read($, runs)).at(-1)
    const saved = await read($, savedChars)
    const told = saved === 0 ? '' : ` About ${tokens(saved)} tokens saved this session.`

    return {
      text:
        latest === undefined
          ? `Build pane opened. No runs yet.${told}`
          : `Build pane opened. Last: ${latest.label}: ${verdict(latest)} · ${tally(latest)}.${told}`,
    }
  })

  on('tool.call', { tool: /^mcp__buildpane__details$/ }, async ($, e) => {
    const latest = (await read($, runs)).findLast(one => one.status !== 'running')
    const asked = (e as { show?: unknown }).show
    const show: Detail = asked === 'errors' || asked === 'warnings' || asked === 'tests' || asked === 'raw' ? asked : 'all'

    if (latest === undefined) {
      return { result: 'No build, test run or lint run has finished in this session yet.' }
    }

    if (show === 'raw') {
      return { result: raw.get(latest.id) ?? (latest.logPath === null ? 'The output is no longer kept.' : `Full output: ${latest.logPath}`) }
    }

    return { result: details(latest, show) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = findInvocations(e.command)
    const [invocation] = found

    if (invocation === undefined || e.run_in_background === true) {
      return next(e)
    }

    const id = e.tool_use_id
    const startedAt = await $.clock.now()
    const running: Run = {
      id,
      label: found.length === 1 ? invocation.label : found.map(one => one.label).join(' + '),
      kind: found.some(one => one.kind === 'test') ? 'test' : invocation.kind,
      status: 'running',
      startedAt,
      durationMs: null,
      errorCount: 0,
      warningCount: 0,
      issues: [],
      tests: null,
      logPath: null,
      logLines: 0,
      hasFindings: false,
      isCondensed: false,
      savedChars: 0,
    }
    const ran = await track($, running, autoOpen, () => next(e))

    if (ran.deny !== undefined) {
      await drop($, id)

      return ran
    }

    const shown = ran.text ?? ''
    let output = shown
    let logPath: string | null = null
    let isStopped = false

    if (ran.isError === true) {
      output = typeof ran.result === 'string' ? ran.result : shown
    } else {
      const persisted = ran.result.persistedOutputPath
      output = [ran.result.stdout, ran.result.stderr].filter(Boolean).join('\n')
      isStopped = ran.result.interrupted || ran.result.backgroundTaskId !== undefined

      if (persisted !== undefined) {
        logPath = persisted
        output = await $.fs.read(persisted).catch(() => output)
      }
    }

    const report = parse(output, found.length === 1 ? invocation.tool : 'script')
    const errorCount = report.issues.filter(isError).length
    const failedTests = report.tests?.failed ?? 0
    const hasFailed = ran.isError === true || report.verdict === 'failed' || errorCount > 0 || failedTests > 0
    const hasFindings = report.issues.length > 0 || report.tests !== null || report.verdict !== null
    const finished: Run = {
      ...running,
      status: isStopped ? 'cancelled' : hasFailed ? 'failed' : 'succeeded',
      durationMs: (await $.clock.now()) - startedAt,
      errorCount,
      warningCount: report.issues.length - errorCount,
      issues: sorted(report.issues),
      tests: report.tests,
      logPath,
      logLines: report.lines,
      hasFindings,
    }
    // A failure nothing was read out of is left as it is: Claude needs the raw output to see why.
    const isReadable = hasFindings && (finished.status === 'succeeded' || errorCount > 0 || failedTests > 0)

    raw.set(id, output.slice(-RAW_CHARS))

    for (const old of [...raw.keys()].slice(0, -KEPT_RAW)) {
      raw.delete(old)
    }

    if (wantsCondense && isReadable && !isStopped && ran.text !== undefined) {
      const exit = /^Exit code (\d+)/.exec(shown)
      const summary = condense(finished, {
        warnings,
        exitCode: exit === null ? null : Number(exit[1]),
        tail: report.tail,
        detailsTool: DETAILS_TOOL,
      })

      if (summary.length < ran.text.length * WORTH_IT) {
        condensed.set(id, summary)
        finished.isCondensed = true
        finished.savedChars = ran.text.length - summary.length
      }
    }

    await announce($, finished, autoOpen)

    return ran
  })

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    let saved = 0
    const content = e.message.content.map(block => {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const summary = block.type === 'tool_result' ? condensed.get(id) : undefined

      if (summary === undefined) {
        return block
      }

      condensed.delete(id)
      saved += Math.max(0, textLength(block.content) - summary.length)

      return { ...block, content: typeof block.content === 'string' ? summary : [{ type: 'text', text: summary }] }
    })

    if (saved === 0) {
      return next(e)
    }

    const stored = await next({ ...e, message: { ...e.message, content } })
    await update($, savedChars, total => total + saved)
    const before = Number((await $.store.get(SAVED_KEY).catch(() => 0)) ?? 0)
    await $.store.set(SAVED_KEY, (Number.isFinite(before) ? before : 0) + saved).catch(() => undefined)

    return stored
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const run = wantsCompactRow ? (await read($, runs)).find(one => one.id === e.requestId) : undefined

    if (run === undefined || run.status === 'running' || !run.isCondensed) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const errors = run.issues.filter(isError)
    const failures = run.tests?.failures ?? []
    const facts = [tally(run), seconds(run.durationMs ?? 0), `${plural(run.logLines, 'line')} folded`]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{'  ⎿  '}</Text>
          <Text bold color={TONE[run.status]}>{`${GLYPH[run.status]} ${verdict(run)}`}</Text>
          <Text dimColor>{` · ${facts.join(' · ')}`}</Text>
        </Box>
        {errors.slice(0, ROW_ERRORS).map(issue => (
          <Text wrap="truncate-end">
            {`     ${[issue.file === null ? null : basename(issue.file), location(issue)].filter(Boolean).join(':')}  ${issue.message}`}
          </Text>
        ))}
        {errors.length === 0 &&
          failures.slice(0, ROW_ERRORS).map(failure => <Text wrap="truncate-end">{`     ${failure.name}  ${failure.message}`}</Text>)}
        {errors.length > ROW_ERRORS && (
          <Text dimColor>{`     +${plural(run.errorCount - ROW_ERRORS, 'more error')} · /${COMMAND} shows them all`}</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const latest = list.at(-1)
    const saved = await read($, savedChars)
    const lifetime = (await read($, savedBefore)) + saved
    const savings =
      lifetime === 0 ? null : `Saved about ${tokens(saved)} tokens this session · ${tokens(lifetime)} in all`

    if (latest === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No runs yet.</Text>
          <Text dimColor>Ask Claude to build, test or lint: tsc, cargo, go, pytest, jest, gradle and more.</Text>
          {savings !== null && <Text dimColor>{savings}</Text>}
        </Box>
      )
    }

    const showsWarnings = await read($, isShowingWarnings)
    const elapsed = latest.status === 'running' ? Math.max(0, (await read($, now)) - latest.startedAt) : (latest.durationMs ?? 0)
    const visible = latest.issues.filter(one => showsWarnings || isError(one))
    const groups = byFile(visible.slice(0, PANE_ISSUES))
    const failures = latest.tests?.failures ?? []
    const earlier = list.slice(0, -1).slice(-5).reverse()
    const hasNothingToShow = latest.status === 'failed' && latest.errorCount === 0 && failures.length === 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold color={TONE[latest.status]}>{`${GLYPH[latest.status]} ${verdict(latest)}`}</Text>
          <Text dimColor>{`  ${seconds(elapsed)}`}</Text>
        </Box>
        <Text dimColor>{latest.label}</Text>
        {latest.status !== 'running' && <Text>{tally(latest)}</Text>}
        {groups.map(group => (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text bold>{group.file === null ? 'Project' : basename(group.file)}</Text>
              <Text dimColor>{`  ${plural(group.issues.length, 'issue')}`}</Text>
            </Box>
            {group.issues.map(issue => (
              <Box flexDirection="row">
                <Box width={9} flexShrink={0}>
                  <Text color={isError(issue) ? 'error' : 'warning'}>{`  ${location(issue) || (isError(issue) ? 'error' : 'warn')}`}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text>{issue.code === null ? issue.message : `${issue.message} (${issue.code})`}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
        {visible.length > PANE_ISSUES && <Text dimColor>{`+${plural(visible.length - PANE_ISSUES, 'more issue')}`}</Text>}
        {failures.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Failed tests</Text>
            {failures.slice(0, PANE_ISSUES).map(failure => (
              <Box flexDirection="column">
                <Text color="error">{`  ${GLYPH.failed} ${failure.name}`}</Text>
                {failure.message !== '' && <Text>{`    ${failure.message}`}</Text>}
              </Box>
            ))}
          </Box>
        )}
        {hasNothingToShow && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>No diagnostics found in the output; Claude read it as it was.</Text>
          </Box>
        )}
        <Box flexDirection="row" gap={2} marginTop={1}>
          {latest.warningCount > 0 && (
            <Button
              key="warnings"
              hotkey="w"
              plain
              label={showsWarnings ? 'Hide warnings' : `Show ${plural(latest.warningCount, 'warning')}`}
              onPress={() => update($, isShowingWarnings, shows => !shows)}
            />
          )}
          <Button key="clear" hotkey="c" plain label="Clear" onPress={() => update($, runs, () => [])} />
        </Box>
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Earlier</Text>
            {earlier.map(run => (
              <Box flexDirection="row">
                <Text color={TONE[run.status]}>{`  ${GLYPH[run.status]} `}</Text>
                <Text dimColor>{`${run.label} · ${tally(run)} · ${seconds(run.durationMs ?? 0)}`}</Text>
              </Box>
            ))}
          </Box>
        )}
        {savings !== null && (
          <Box marginTop={1}>
            <Text dimColor>{savings}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
