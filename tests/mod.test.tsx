import type { Args, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CARGO_BUILD_FAILED, PYTEST_PASSED, TSC_FAILED, UNREADABLE_FAILED } from './fixtures'

const PLUGIN = 'buildpane'
const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'buildpane',
  props: {
    title: 'Build',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 40 },
} as const

type SessionAppendMessage = Args<'session.append'>['message']

/** What the Bash tool answers, as core does: an errored call's `result` is the text the model read. */
type Bash = { text: string; isError?: true }

const callTool = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call(input as never) as Promise<{ result?: unknown; isError?: true }>

/** Runs the mod's slash command as typed at the prompt. */
const slash = ($: Engine, args: string) =>
  $.command.run({ command: 'buildpane', args } as never) as Promise<{ text?: string }>

const failed = (log: string, code = 1) => ({ text: `Exit code ${code}\n${log}`, isError: true }) as const

const world = (on: On, bash: Bash, stored: Record<string, unknown> = {}) => {
  const seen = {
    commands: [] as string[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    opened: [] as string[],
    rows: [] as SessionAppendMessage[],
    store: { ...stored } as Record<string, unknown>,
  }
  mock.clock(on, { now: 1_000 })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('store.get', (_$, e) => ({ value: seen.store[e.key] }))
  on('store.set', (_$, e) => {
    seen.store[e.key] = e.value

    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.commands.push(e.command)

    return bash.isError === true
      ? { isError: true, result: bash.text, text: bash.text }
      : { result: { stdout: bash.text, stderr: '', interrupted: false }, text: bash.text }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  // The store itself is the engine's: a hook may only relay it, so the test
  // records the row that reached the bottom and lets `next` fail beneath it.
  on('session.append', (_$, e, next) => {
    seen.rows.push(e.message)

    return next(e)
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>the raw output</Text>
  })

  return seen
}

/** Appends a Bash call's result row as the engine does and answers what the model would read of it. */
const modelReads = async ($: Engine, seen: ReturnType<typeof world>, id: string, text: string) => {
  await $.session
    .append({
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: `row-${id}`,
    })
    .catch(() => undefined)

  return seen.rows.at(-1)?.content[0]
}

const NOISE = Array.from({ length: 80 }, (_, i) => `   Compiling dep-${i} v1.0.${i}`).join('\n')

test('a failing build: the pane lists the errors by file and Claude reads them, not the log', async ($, on) => {
  const bash = failed(`${NOISE}\n${CARGO_BUILD_FAILED}`, 101)
  const seen = world(on, bash)

  const ran = await $.tool.call({ tool: 'Bash', command: 'cargo build 2>&1', tool_use_id: 'toolu_1' })

  expect(ran.isError).toBe(true)
  expect(seen.commands).toEqual(['cargo build 2>&1'])
  expect(seen.opened).toEqual(['buildpane'])
  expect(seen.statuses.at(-1)).toBe('✗ cargo build: 1 error · 1 warning')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /BUILD FAILED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'lib.rs' })).toMatchObject({ props: { bold: true } })
    expect(await ui.find({ type: 'Text', text: /mismatched types \(E0308\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unused variable/ })).toBeUndefined()

    await ui.press({ key: 'warnings' })
    expect(await ui.find({ type: 'Text', text: /unused variable/ })).toBeDefined()
    await ui.press({ key: 'warnings' })
    await ui.unmount()
  }

  const block = await modelReads($, seen, 'toolu_1', bash.text)
  expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true })
  expect(block?.content).toContain('cargo build: BUILD FAILED')
  expect(block?.content).toContain('src/lib.rs:7:5: error E0308: mismatched types')
  expect(block?.content).toContain('(exit code 101)')
  expect(block?.content).not.toContain('Compiling dep-3 ')
  expect(String(block?.content).length).toBeLessThan(bash.text.length / 2)
})

test('the characters saved are counted for the session and kept across sessions', async ($, on) => {
  const bash = failed(`${NOISE}\n${CARGO_BUILD_FAILED}`, 101)
  const seen = world(on, bash, { savedChars: 4_000_000 })

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'toolu_1' })
  const block = await modelReads($, seen, 'toolu_1', bash.text)
  const saved = bash.text.length - String(block?.content).length

  expect(saved).toBeGreaterThan(1000)
  expect(Number(seen.store.savedChars)).toBe(4_000_000 + saved)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Saved about/ }))?.text).toMatch(/^Saved about \d+ tokens this session · 1\.00M in all$/)
  await ui.unmount()
})

test('a condensed run draws its verdict in the transcript row, and other rows are left alone', async ($, on) => {
  world(on, failed(`${NOISE}\n${CARGO_BUILD_FAILED}`, 101))
  await $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'toolu_1' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const row = (id: string) =>
      $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'ToolResult',
        requestId: id,
        props: { tool_use_id: id, tool: 'Bash', output: 'Exit code 101', isErrored: true },
      })
    const build = await row('toolu_1')
    expect(await build.find({ type: 'Text', text: /✗ BUILD FAILED/ })).toBeDefined()
    expect(await build.find({ type: 'Text', text: /lib\.rs:7:5 {2}mismatched types/ })).toBeDefined()
    await build.unmount()

    const other = await row('toolu_other')
    expect((await other.find({ type: 'Text' }))?.text).toBe('the raw output')
    await other.unmount()
  }
})

test('a passing test run is toasted and condensed to its counts', async ($, on) => {
  const seen = world(on, { text: PYTEST_PASSED })

  await $.tool.call({ tool: 'Bash', command: 'uv run pytest', tool_use_id: 'toolu_2' })

  expect(seen.opened).toEqual([])
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.toasts.at(-1)).toMatch(/^✓ pytest · 0 errors · 0 warnings · 240 tests, 0 failed/)
  const block = await modelReads($, seen, 'toolu_2', PYTEST_PASSED)
  expect(block?.content).toContain('pytest: TEST SUCCEEDED')
  expect(block?.content).toContain('240 tests, 0 failed')
})

test('a failure nothing is read out of reaches Claude as it was', async ($, on) => {
  const bash = failed(UNREADABLE_FAILED)
  const seen = world(on, bash)

  await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'toolu_3' })

  expect(seen.statuses.at(-1)).toBe('✗ npm run build: 0 errors · 0 warnings')
  const block = await modelReads($, seen, 'toolu_3', bash.text)
  expect(block?.content).toBe(bash.text)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No diagnostics found in the output/ })).toBeDefined()
  await ui.unmount()
})

test('a short output is not worth replacing', async ($, on) => {
  const bash = failed(TSC_FAILED, 2)
  const seen = world(on, bash)

  await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit', tool_use_id: 'toolu_4' })

  expect(seen.statuses.at(-1)).toBe('✗ tsc: 3 errors · 0 warnings')
  const block = await modelReads($, seen, 'toolu_4', bash.text)
  expect(block?.content).toBe(bash.text)
})

test('with condense off Claude reads the raw output, and the pane still shows the run', { options: { condense: false } }, async ($, on) => {
  const bash = failed(`${NOISE}\n${CARGO_BUILD_FAILED}`, 101)
  const seen = world(on, bash)

  await $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'toolu_5' })

  const block = await modelReads($, seen, 'toolu_5', bash.text)
  expect(block?.content).toBe(bash.text)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /mismatched types/ })).toBeDefined()
  await ui.unmount()
})

test('other commands and background runs pass through untouched', async ($, on) => {
  const seen = world(on, { text: 'ok' })

  await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 'toolu_6' })
  await $.tool.call({ tool: 'Bash', command: 'cargo build', run_in_background: true, tool_use_id: 'toolu_7' })

  expect(seen.opened).toEqual([])
  expect(seen.statuses).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('the details tool lists the last run in full, and its raw output on request', async ($, on) => {
  world(on, failed(`${NOISE}\n${CARGO_BUILD_FAILED}`, 101))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await callTool($, { tool: 'mcp__buildpane__details', tool_use_id: 'toolu_a' })).result).toContain('No build')

  await $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'toolu_8' })

  const all = await callTool($, { tool: 'mcp__buildpane__details', show: 'warnings', tool_use_id: 'toolu_b' })
  expect(all.result).toContain('src/lib.rs:2:9: warning: unused variable: `unused`')
  const raw = await callTool($, { tool: 'mcp__buildpane__details', show: 'raw', tool_use_id: 'toolu_c' })
  expect(raw.result).toContain('Compiling dep-79 v1.0.79')
})

test('/buildpane opens the pane and clear forgets the runs', async ($, on) => {
  const seen = world(on, failed(`${NOISE}\n${CARGO_BUILD_FAILED}`, 101))
  await $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'toolu_9' })

  const opened = await slash($, '')
  expect(opened).toMatchObject({ text: expect.stringContaining('Last: cargo build: BUILD FAILED') })
  expect(seen.opened).toEqual(['buildpane', 'buildpane'])

  await slash($, 'clear')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No runs yet/ })).toBeDefined()
  await ui.unmount()
})
