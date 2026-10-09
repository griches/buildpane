import { describe, expect, test } from 'claude-code/testing'

import { findInvocations } from '../hooks/detect'
import { condense, details, tokens } from '../hooks/format'
import { parse } from '../hooks/parse'
import type { Run } from '../types'
import {
  CARGO_BUILD_FAILED,
  CARGO_TEST_FAILED,
  ESLINT_FAILED,
  GO_BUILD_FAILED,
  GO_TEST_FAILED,
  GRADLE_FAILED,
  JEST_FAILED,
  MYPY_FAILED,
  PYTEST_FAILED,
  PYTEST_PASSED,
  RUFF_FAILED,
  TSC_FAILED,
  TSC_PRETTY_FAILED,
  UNREADABLE_FAILED,
  VITEST_FAILED,
} from './fixtures'

const labels = (command: string) => findInvocations(command).map(one => one.label)

describe('which commands are read', () => {
  test('a tool run by name, through a runner or a wrapper', () => {
    expect(labels('tsc -p .')).toEqual(['tsc'])
    expect(labels('npx tsc --noEmit')).toEqual(['tsc'])
    expect(labels('pnpm exec vitest run')).toEqual(['vitest'])
    expect(labels('cd app && cargo test --lib 2>&1 | tail -40')).toEqual(['cargo test'])
    expect(labels('cargo +nightly clippy')).toEqual(['cargo clippy'])
    expect(labels('python3 -m pytest -q')).toEqual(['pytest'])
    expect(labels('uv run pytest tests/')).toEqual(['pytest'])
    expect(labels('go test ./...')).toEqual(['go test'])
    expect(labels('./gradlew assembleDebug')).toEqual(['gradlew assembleDebug'])
    expect(labels('CI=1 time ruff check .')).toEqual(['ruff check'])
  })

  test('a package script that builds, tests or lints', () => {
    expect(labels('npm test')).toEqual(['npm test'])
    expect(labels('npm run build')).toEqual(['npm run build'])
    expect(labels('pnpm typecheck')).toEqual(['pnpm run typecheck'])
    expect(labels('yarn lint && yarn test')).toEqual(['yarn run lint', 'yarn test'])
    expect(findInvocations('npm run test:unit')[0]?.kind).toBe('test')
  })

  test('what is left alone', () => {
    expect(labels('npm run dev')).toEqual([])
    expect(labels('npm install')).toEqual([])
    expect(labels('tsc --watch')).toEqual([])
    expect(labels('cargo run')).toEqual([])
    expect(labels('gradle tasks')).toEqual([])
    expect(labels('echo "cargo build"')).toEqual([])
    expect(labels('xcodebuild -scheme Demo build')).toEqual([])
    expect(labels('swift build')).toEqual([])
    expect(labels('git status')).toEqual([])
  })
})

describe('what each toolchain said', () => {
  test('tsc, plain and pretty', () => {
    for (const raw of [TSC_FAILED, TSC_PRETTY_FAILED]) {
      const { issues } = parse(raw, 'tsc')
      expect(issues).toHaveLength(3)
      expect(issues[0]).toEqual({
        severity: 'error',
        file: 'src/greet.ts',
        line: 3,
        column: 58,
        code: 'TS2552',
        message: "Cannot find name 'nam'. Did you mean 'name'?",
      })
    }

    expect(parse(TSC_PRETTY_FAILED, 'tsc').verdict).toBe('failed')
  })

  test('eslint', () => {
    const report = parse(ESLINT_FAILED, 'eslint')
    expect(report.verdict).toBe('failed')
    expect(report.issues.map(one => [one.severity, one.line, one.code])).toEqual([
      ['warning', 1, 'no-var'],
      ['error', 1, 'no-unused-vars'],
      ['error', 2, 'no-undef'],
    ])
    expect(report.issues[1]?.file).toBe('/Users/dev/demo/src/lint.js')
    expect(report.issues[1]?.message).toBe("'unused' is assigned a value but never used")
  })

  test('cargo build', () => {
    const report = parse(CARGO_BUILD_FAILED, 'cargo')
    expect(report.verdict).toBe('failed')
    expect(report.issues).toEqual([
      { severity: 'error', file: 'src/lib.rs', line: 7, column: 5, code: 'E0308', message: 'mismatched types' },
      { severity: 'warning', file: 'src/lib.rs', line: 2, column: 9, code: null, message: 'unused variable: `unused`' },
    ])
    expect(report.tail).toEqual([
      'For more information about this error, try `rustc --explain E0308`.',
      'error: could not compile `demo` (lib) due to 1 previous error; 1 warning emitted',
    ])
  })

  test('cargo test', () => {
    const report = parse(CARGO_TEST_FAILED, 'cargo')
    expect(report.verdict).toBe('failed')
    expect(report.issues.filter(one => one.severity === 'error')).toEqual([])
    expect(report.tests).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [
        {
          name: 'tests::adds_wrong',
          message: 'assertion `left == right` failed: sums should match',
          file: 'src/lib.rs',
          line: 17,
        },
      ],
    })
  })

  test('vitest', () => {
    expect(parse(VITEST_FAILED, 'vitest').tests).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [
        {
          name: 'src/maths.test.js > maths > adds wrong',
          message: 'AssertionError: expected 4 to be 5 // Object.is equality',
          file: 'src/maths.test.js',
          line: 5,
        },
      ],
    })
  })

  test('jest', () => {
    expect(parse(JEST_FAILED, 'jest').tests).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [
        {
          name: 'maths › adds wrong',
          message: 'expect(received).toBe(expected) // Object.is equality',
          file: 'maths.test.cjs',
          line: 4,
        },
      ],
    })
  })

  test('pytest', () => {
    expect(parse(PYTEST_FAILED, 'pytest').tests).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'tests/test_maths.py::test_adds_wrong', message: 'assert 4 == 5', file: 'tests/test_maths.py', line: 9 }],
    })
    expect(parse(PYTEST_PASSED, 'pytest').tests).toMatchObject({ total: 240, passed: 240, failed: 0 })
  })

  test('go', () => {
    const built = parse(GO_BUILD_FAILED, 'go')
    expect(built.issues).toHaveLength(2)
    expect(built.issues[0]).toMatchObject({ severity: 'error', file: './maths.go', line: 7, column: 9 })

    const tested = parse(GO_TEST_FAILED, 'go')
    expect(tested.verdict).toBe('failed')
    expect(tested.tests).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'TestAddWrong', message: 'add(2, 2) = 4, want 5', file: 'maths_test.go', line: 14 }],
    })
  })

  test('gradle with kotlinc, mypy and ruff', () => {
    const gradle = parse(GRADLE_FAILED, 'gradle')
    expect(gradle.verdict).toBe('failed')
    expect(gradle.issues.map(one => [one.severity, one.file, one.line])).toEqual([
      ['error', '/Users/dev/demo/app/src/main/kotlin/Maths.kt', 7],
      ['warning', '/Users/dev/demo/app/src/main/kotlin/Maths.kt', 3],
    ])

    const mypy = parse(MYPY_FAILED, 'mypy')
    expect(mypy.issues).toHaveLength(2)
    expect(mypy.issues[0]).toMatchObject({ file: 'src/maths.py', line: 7, column: null, code: 'return-value' })
    expect(mypy.issues[1]).toMatchObject({ file: 'src/greet.py', line: 3, column: 12, code: 'name-defined' })

    expect(parse(RUFF_FAILED, 'ruff').issues.map(one => one.code)).toEqual(['F401', 'E501'])
  })

  test('a script is read whichever runner is behind it', () => {
    expect(parse(VITEST_FAILED, 'script').tests?.failed).toBe(1)
    expect(parse(PYTEST_FAILED, 'script').tests?.failed).toBe(1)
    expect(parse(TSC_FAILED, 'script').issues).toHaveLength(3)
  })

  test('a huge minified line is cut, not matched whole', () => {
    const report = parse(`${'a.b('.repeat(500_000)}\n${TSC_FAILED}`, 'script')
    expect(report.issues).toHaveLength(3)
  })

  test('output nothing is read from says so', () => {
    const report = parse(UNREADABLE_FAILED, 'script')
    expect(report.issues).toEqual([])
    expect(report.tests).toBeNull()
    expect(report.verdict).toBeNull()
    expect(report.tail.at(-1)).toBe('RuntimeError: the bundler crashed')
  })
})

describe('what Claude reads', () => {
  const run = (raw: string, tool: string, more: Partial<Run> = {}): Run => {
    const report = parse(raw, tool)
    const errorCount = report.issues.filter(one => one.severity === 'error').length

    return {
      id: 'toolu_1',
      label: tool,
      kind: 'build',
      status: 'failed',
      startedAt: 0,
      durationMs: 2300,
      errorCount,
      warningCount: report.issues.length - errorCount,
      issues: report.issues,
      tests: report.tests,
      logPath: null,
      logLines: report.lines,
      hasFindings: true,
      isCondensed: false,
      savedChars: 0,
      ...more,
    }
  }
  const settings = { warnings: 'count', exitCode: 101, tail: ['error: could not compile `demo`'], detailsTool: 'mcp__buildpane__details' } as const

  test('a failed build: every error, the warnings counted, the end of the output kept', () => {
    const summary = condense(run(CARGO_BUILD_FAILED, 'cargo'), settings)
    expect(summary).toContain('cargo: BUILD FAILED in 2.3s (exit code 101)')
    expect(summary).toContain('src/lib.rs:7:5: error E0308: mismatched types')
    expect(summary).toContain('1 warning not listed: lib.rs (1). Call mcp__buildpane__details to list them.')
    expect(summary).toContain('Other lines that mention a failure:\n  error: could not compile `demo`')
    expect(summary).not.toContain('unused variable')
    expect(condense(run(CARGO_BUILD_FAILED, 'cargo'), { ...settings, warnings: 'list' })).toContain('unused variable')
  })

  test('a passed test run is a few lines', () => {
    const summary = condense(run(PYTEST_PASSED, 'pytest', { kind: 'test', status: 'succeeded' }), { ...settings, exitCode: null })
    expect(summary).toContain('pytest: TEST SUCCEEDED')
    expect(summary).toContain('240 tests, 0 failed')
    expect(summary).not.toContain('mention a failure')
    expect(summary.length).toBeLessThan(PYTEST_PASSED.length / 3)
  })

  test('the details tool lists what the summary counted', () => {
    const listed = details(run(CARGO_TEST_FAILED, 'cargo', { kind: 'test' }), 'all')
    expect(listed).toContain('src/lib.rs:2:9: warning: unused variable: `unused`')
    expect(listed).toContain('tests::adds_wrong: assertion `left == right` failed: sums should match (src/lib.rs:17)')
  })

  test('tokens are counted from characters', () => {
    expect(tokens(400)).toBe('100')
    expect(tokens(49_600)).toBe('12.4k')
    expect(tokens(8_000_000)).toBe('2.00M')
  })
})
