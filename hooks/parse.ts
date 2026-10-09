import type { Issue, TestFailure, Tests } from '../types'

export type Report = {
  issues: Issue[]
  tests: Tests | null
  /** What the tool itself said of the run, when it said so in words. */
  verdict: 'passed' | 'failed' | null
  lines: number
  /** The last lines that speak of a failure without being one the rules above read. */
  tail: string[]
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const PATH = String.raw`((?:[A-Za-z]:)?[^\s:()'"]+\.[A-Za-z0-9]+)`
const TAIL_LINES = 6
const TAIL_WIDTH = 240
const FAILURE_WORDS = /\b(error|fatal|fail(ed|ure)?|exception|panicked|undefined (reference|symbols?)|\w+Error)\b/i

// `src/a.ts(12,5): error TS2322: ...` (tsc, MSBuild, C#)
const PARENS = new RegExp(String.raw`^\s*${PATH}\((\d+),(\d+)\): (error|warning) ([A-Za-z]+\d+): (.+)$`)
// `src/a.ts:12:5 - error TS2322: ...` (tsc --pretty, pyright)
const DASHED = new RegExp(String.raw`^\s*${PATH}:(\d+):(\d+) - (error|warning)(?: ([A-Za-z]+\d+))?: (.+)$`)
// `src/a.c:12:5: error: ...` (gcc, clang, swiftc, javac, mypy)
const COLONS = new RegExp(String.raw`^\s*${PATH}:(\d+)(?::(\d+))?: (?:fatal )?(error|warning): (.+)$`)
// `e: file:///src/A.kt:12:5 ...` and the older `e: /src/A.kt: (12, 5): ...` (kotlinc)
const KOTLIN = new RegExp(String.raw`^(e|w): (?:file://)?${PATH}:(\d+):(\d+):? (.+)$`)
const KOTLIN_OLD = new RegExp(String.raw`^(e|w): (?:file://)?${PATH}: \((\d+), (\d+)\): (.+)$`)
// `error[E0308]: mismatched types` then `  --> src/main.rs:4:18` (rustc)
const RUST = /^(error|warning)(?:\[([A-Z]\d+)\])?: (.+)$/
const RUST_AT = new RegExp(String.raw`^\s*--> ${PATH}:(\d+):(\d+)`)
const RUST_NOISE =
  /^(could not compile|aborting due to|test failed|build failed|process didn't exit|unused manifest key|.*\bgenerated \d+ warnings?\b|.*\bwarnings? emitted\b|failed to run custom build)/i
// `./main.go:10:2: undefined: foo` (go build, go vet): no severity word.
const GO = /^(?:vet: )?((?:\.{1,2}\/)?[^\s:]+\.go):(\d+):(\d+): (.+)$/
// `src/a.py:12:5: E501 Line too long` (ruff, flake8)
const RUFF = new RegExp(String.raw`^${PATH}:(\d+):(\d+): ([A-Z]+\d+) (.+)$`)
// eslint's default report: a path on a line of its own, then `  12:5  error  message  rule`.
const ESLINT_FILE = /^(?:[A-Za-z]:)?[^\s:]*[\\/][^\s:]*\.[A-Za-z0-9]+$/
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/
const PROJECT_SUFFIX = /\s\[[^\]]+proj\]$/

const FAILED_MARKS = [
  /^Found \d+ errors?\b/,
  /^✖ \d+ problems? \((?!0 errors)/,
  /^error: could not compile\b/,
  /^BUILD FAIL(ED|URE)\b/,
  /^Build FAILED\./,
  /^FAIL\b(?!ED TESTS)/,
  /^make(\[\d+\])?: \*\*\* /,
  /^ninja: build stopped/,
  /^error: test failed/,
]
const PASSED_MARKS = [
  /^Success: no issues found/,
  /^All checks passed!/,
  /^\s*Finished [`'a-z]/,
  /^BUILD SUCCESS(FUL)?\b/,
  /^Build succeeded\./,
  /^0 errors, 0 warnings/,
]

const number = (text: string | undefined) => (text === undefined || text === '' ? null : Number(text))

const count = (text: string, word: RegExp) => {
  const found = new RegExp(String.raw`(\d+) ${word.source}`).exec(text)

  return found === null ? 0 : Number(found[1])
}

const issuesOf = (lines: readonly string[], tool: string): Issue[] => {
  const found: Issue[] = []
  const seen = new Set<string>()
  let eslintFile: string | null = null
  const add = (issue: Issue) => {
    const key = `${issue.severity}|${issue.file}|${issue.line}|${issue.column}|${issue.message}`

    if (!seen.has(key)) {
      seen.add(key)
      found.push(issue)
    }
  }

  lines.forEach((line, at) => {
    let m: RegExpExecArray | null

    if ((m = PARENS.exec(line)) !== null) {
      add({
        severity: m[4] === 'warning' ? 'warning' : 'error',
        file: m[1] ?? null,
        line: number(m[2]),
        column: number(m[3]),
        code: m[5] ?? null,
        message: (m[6] ?? '').replace(PROJECT_SUFFIX, ''),
      })
    } else if ((m = DASHED.exec(line)) !== null) {
      add({
        severity: m[4] === 'warning' ? 'warning' : 'error',
        file: m[1] ?? null,
        line: number(m[2]),
        column: number(m[3]),
        code: m[5] ?? null,
        message: m[6] ?? '',
      })
    } else if ((m = COLONS.exec(line)) !== null) {
      const coded = /^(.*\S)\s+\[([a-z][a-z0-9-]*)\]$/.exec(m[5] ?? '')
      add({
        severity: m[4] === 'warning' ? 'warning' : 'error',
        file: m[1] ?? null,
        line: number(m[2]),
        column: number(m[3]),
        code: coded?.[2] ?? null,
        message: coded?.[1] ?? m[5] ?? '',
      })
    } else if ((m = KOTLIN.exec(line) ?? KOTLIN_OLD.exec(line)) !== null) {
      add({
        severity: m[1] === 'w' ? 'warning' : 'error',
        file: m[2] ?? null,
        line: number(m[3]),
        column: number(m[4]),
        code: null,
        message: m[5] ?? '',
      })
    } else if ((m = RUST.exec(line)) !== null) {
      const where = lines.slice(at + 1, at + 7).map(one => RUST_AT.exec(one)).find(one => one !== null)
      const isNoise = RUST_NOISE.test(m[3] ?? '')

      if (where !== undefined && where !== null) {
        add({
          severity: m[1] === 'warning' ? 'warning' : 'error',
          file: where[1] ?? null,
          line: number(where[2]),
          column: number(where[3]),
          code: m[2] ?? null,
          message: m[3] ?? '',
        })
      } else if (tool === 'cargo' && m[1] === 'error' && !isNoise) {
        add({ severity: 'error', file: null, line: null, column: null, code: m[2] ?? null, message: m[3] ?? '' })
      }
    } else if ((m = RUFF.exec(line)) !== null) {
      add({ severity: 'error', file: m[1] ?? null, line: number(m[2]), column: number(m[3]), code: m[4] ?? null, message: m[5] ?? '' })
    } else if (tool === 'go' && (m = GO.exec(line)) !== null) {
      add({ severity: 'error', file: m[1] ?? null, line: number(m[2]), column: number(m[3]), code: null, message: m[4] ?? '' })
    } else if (eslintFile !== null && (m = ESLINT_ROW.exec(line)) !== null) {
      add({
        severity: m[3] === 'warning' ? 'warning' : 'error',
        file: eslintFile,
        line: number(m[1]),
        column: number(m[2]),
        code: m[5] ?? null,
        message: m[4] ?? '',
      })
    } else if (ESLINT_FILE.test(line)) {
      eslintFile = line
    } else if (line.trim() === '') {
      eslintFile = null
    }
  })

  return found
}

/** The first line after `from` that says something, for a failure whose message follows its name. */
const following = (lines: readonly string[], from: number, isEnd: (line: string) => boolean) => {
  for (let i = from; i < Math.min(lines.length, from + 12); i += 1) {
    const line = lines[i] ?? ''

    if (isEnd(line)) {
      return ''
    }

    if (line.trim() !== '') {
      return line.trim()
    }
  }

  return ''
}

const locate = (lines: readonly string[], from: number, pattern: RegExp, isEnd: (line: string) => boolean) => {
  for (let i = from; i < Math.min(lines.length, from + 40); i += 1) {
    const line = lines[i] ?? ''

    if (i > from && isEnd(line)) {
      break
    }

    const found = pattern.exec(line)

    if (found !== null && !line.includes('node_modules')) {
      return { file: found[1] ?? null, line: number(found[2]) }
    }
  }

  return { file: null, line: null }
}

const pytest = (lines: readonly string[]): Tests | null => {
  const summary = lines.findLast(line => /^=+ .*\b(passed|failed|errors?|skipped|no tests ran)\b.* in [\d.]+s/.test(line))

  if (summary === undefined) {
    return null
  }

  const failed = count(summary, /failed/) + count(summary, /errors?/)
  const passed = count(summary, /passed/)
  const skipped = count(summary, /skipped/) + count(summary, /deselected/) + count(summary, /xfailed/)
  const places = lines.map(line => /^(\S+\.py):(\d+): (\w+)/.exec(line)).filter(one => one !== null)
  const failures: TestFailure[] = lines
    .map(line => /^(FAILED|ERROR) (\S+?)(?: - (.*))?$/.exec(line))
    .filter(one => one !== null)
    .map(found => {
      const name = found[2] ?? ''
      const file = name.split('::')[0] ?? null
      const place = places.findIndex(one => one[1] === file)
      const [where] = place < 0 ? [] : places.splice(place, 1)

      return { name, message: found[3] ?? '', file, line: number(where?.[2]) }
    })

  return { total: passed + failed + skipped, passed, failed, skipped, failures }
}

const jest = (lines: readonly string[]): Tests | null => {
  const summary = lines.findLast(line => /^Tests:\s+.*\d+ total/.test(line))

  if (summary === undefined) {
    return null
  }

  const isHeading = (line: string) => /^\s+● /.test(line)
  const failures: TestFailure[] = []

  lines.forEach((line, at) => {
    const found = /^\s+● (.+ › .+)$/.exec(line)

    if (found !== null && !failures.some(one => one.name === found[1])) {
      failures.push({
        name: found[1] ?? '',
        message: following(lines, at + 1, isHeading),
        ...locate(lines, at + 1, /\(?((?:[A-Za-z]:)?[^\s:()]+\.[cm]?[jt]sx?):(\d+):\d+\)?/, isHeading),
      })
    }
  })

  const failed = count(summary, /failed/)
  const passed = count(summary, /passed/)
  const total = count(summary, /total/)

  return { total, passed, failed, skipped: Math.max(0, total - passed - failed), failures }
}

const vitest = (lines: readonly string[]): Tests | null => {
  const summary = lines.findLast(line => /^\s*Tests\s+.*\(\d+\)\s*$/.test(line))

  if (summary === undefined) {
    return null
  }

  const isHeading = (line: string) => /^\s*(FAIL|×)\s/.test(line) || /^[⎯─-]{6,}/.test(line.trim())
  const failures: TestFailure[] = []

  lines.forEach((line, at) => {
    const found = /^\s*FAIL\s+(\S+) > (.+)$/.exec(line)
    const name = found === null ? '' : `${found[1]} > ${found[2]}`

    if (found !== null && !failures.some(one => one.name === name)) {
      const where = locate(lines, at + 1, /❯ ((?:[A-Za-z]:)?[^\s:()]+\.[cm]?[jt]sx?):(\d+):\d+/, isHeading)
      failures.push({ name, message: following(lines, at + 1, isHeading), file: where.file ?? found[1] ?? null, line: where.line })
    }
  })

  const failed = count(summary, /failed/)
  const passed = count(summary, /passed/)
  const total = Number(/\((\d+)\)\s*$/.exec(summary)?.[1] ?? passed + failed)

  return { total, passed, failed, skipped: Math.max(0, total - passed - failed), failures }
}

const cargo = (lines: readonly string[]): Tests | null => {
  const results = lines.map(line => /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line)).filter(one => one !== null)

  if (results.length === 0) {
    return null
  }

  const sum = (group: number) => results.reduce((total, one) => total + Number(one[group]), 0)
  const isHeading = (line: string) => /^---- .+ ----$/.test(line) || /^failures:/.test(line)
  const failures: TestFailure[] = []

  lines.forEach((line, at) => {
    const found = /^---- (\S+) stdout ----$/.exec(line)

    if (found !== null) {
      const panic = lines.slice(at + 1, at + 12).findIndex(one => /panicked at /.test(one))
      const where = panic < 0 ? null : /panicked at ([^\s:]+):(\d+):\d+/.exec(lines[at + 1 + panic] ?? '')
      const told = panic < 0 ? following(lines, at + 1, isHeading) : following(lines, at + 2 + panic, isHeading)
      failures.push({ name: found[1] ?? '', message: told, file: where?.[1] ?? null, line: number(where?.[2]) })
    }
  })

  const passed = sum(1)
  const failed = sum(2)
  const skipped = sum(3)

  return { total: passed + failed + skipped, passed, failed, skipped, failures }
}

const go = (lines: readonly string[]): Tests | null => {
  const failures: TestFailure[] = []
  let passed = 0
  let skipped = 0

  lines.forEach((line, at) => {
    const found = /^\s*--- (FAIL|PASS|SKIP): (\S+) \(/.exec(line)

    if (found === null) {
      return
    }

    passed += found[1] === 'PASS' ? 1 : 0
    skipped += found[1] === 'SKIP' ? 1 : 0

    if (found[1] === 'FAIL') {
      // The test's own lines follow its verdict, or come before it under -v.
      const said = /^\s+(\S+\.go):(\d+): (.+)$/
      const told = said.exec(lines[at + 1] ?? '') ?? said.exec(lines[at - 1] ?? '')
      failures.push({ name: found[2] ?? '', message: told?.[3] ?? '', file: told?.[1] ?? null, line: number(told?.[2]) })
    }
  })

  // A parent test fails with its subtests; only the leaves say why.
  const leaves = failures.filter(one => !failures.some(other => other.name.startsWith(`${one.name}/`)))
  const total = passed + skipped + leaves.length

  return total === 0 ? null : { total, passed, failed: leaves.length, skipped, failures: leaves }
}

const gradle = (lines: readonly string[]): Tests | null => {
  const summary = lines.map(line => /^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?/.exec(line)).findLast(one => one !== null)
  const failures: TestFailure[] = []

  lines.forEach((line, at) => {
    const found = /^(\S+) > (.+) FAILED$/.exec(line)

    if (found !== null) {
      const where = /\((\w+\.(?:kt|java|groovy|scala)):(\d+)\)/.exec(lines.slice(at + 1, at + 8).join('\n'))
      failures.push({
        name: `${found[1]} > ${found[2]}`,
        message: following(lines, at + 1, one => / FAILED$/.test(one)),
        file: where?.[1] ?? null,
        line: number(where?.[2]),
      })
    }
  })

  if (summary === undefined || summary === null) {
    return failures.length === 0 ? null : { total: failures.length, passed: 0, failed: failures.length, skipped: 0, failures }
  }

  const total = Number(summary[1])
  const failed = Number(summary[2] ?? 0)
  const skipped = Number(summary[3] ?? 0)

  return { total, passed: total - failed - skipped, failed, skipped, failures }
}

const dotnet = (lines: readonly string[]): Tests | null => {
  const summary = lines
    .map(line => /Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/.exec(line))
    .filter(one => one !== null)

  if (summary.length === 0) {
    return null
  }

  const sum = (group: number) => summary.reduce((total, one) => total + Number(one[group]), 0)
  const failures: TestFailure[] = []

  lines.forEach((line, at) => {
    const found = /^\s+Failed (\S+) \[/.exec(line)

    if (found !== null) {
      const told = lines.slice(at + 1, at + 6).findIndex(one => /Error Message:/.test(one))
      const where = /in (\S+\.\w+):line (\d+)/.exec(lines.slice(at + 1, at + 14).join('\n'))
      failures.push({
        name: found[1] ?? '',
        message: told < 0 ? '' : (lines[at + 2 + told] ?? '').trim(),
        file: where?.[1] ?? null,
        line: number(where?.[2]),
      })
    }
  })

  return { total: sum(4), passed: sum(2), failed: sum(1), skipped: sum(3), failures }
}

const bun = (lines: readonly string[]): Tests | null => {
  const passed = lines.map(line => /^\s*(\d+) pass$/.exec(line)).findLast(one => one !== null)
  const failed = lines.map(line => /^\s*(\d+) fail$/.exec(line)).findLast(one => one !== null)

  if (passed === undefined || passed === null || failed === undefined || failed === null) {
    return null
  }

  const skipped = Number(lines.map(line => /^\s*(\d+) skip$/.exec(line)).findLast(one => one !== null)?.[1] ?? 0)
  const failures = lines
    .map(line => /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line))
    .filter(one => one !== null)
    .map(found => ({ name: found[1] ?? '', message: '', file: null, line: null }))

  return { total: Number(passed[1]) + Number(failed[1]) + skipped, passed: Number(passed[1]), failed: Number(failed[1]), skipped, failures }
}

const TESTS: Record<string, (lines: readonly string[]) => Tests | null> = { pytest, jest, vitest, cargo, go, gradle, maven: gradle, dotnet, bun }

const testsOf = (lines: readonly string[], tool: string): Tests | null => {
  const own = TESTS[tool]?.(lines) ?? null

  if (own !== null) {
    return own
  }

  // A package script or a Makefile target: the runner behind it is not named, so each is asked.
  for (const read of [pytest, jest, vitest, cargo, dotnet, bun, gradle]) {
    const found = read(lines)

    if (found !== null) {
      return found
    }
  }

  return tool === 'script' || tool === 'make' ? go(lines) : null
}

/** What a build's, test run's or lint run's output says, whichever toolchain wrote it. */
export const parse = (raw: string, tool: string): Report => {
  const lines = raw.replace(ANSI, '').replaceAll('\r\n', '\n').split('\n')
  const hasFailed = lines.some(line => FAILED_MARKS.some(mark => mark.test(line)))
  const hasPassed = lines.some(line => PASSED_MARKS.some(mark => mark.test(line)))

  const issues = issuesOf(lines, tool)
  const tests = testsOf(lines, tool)
  const told = [...issues.map(one => one.message), ...(tests?.failures ?? []).flatMap(one => [one.name, one.message])].filter(one => one !== '')

  return {
    issues,
    tests,
    verdict: hasFailed ? 'failed' : hasPassed ? 'passed' : null,
    lines: lines.length,
    // Lines that speak of a failure and are not one already read: a linker error, a crash, a missing tool.
    tail: lines
      .filter(line => FAILURE_WORDS.test(line) && !told.some(one => line.includes(one)))
      .slice(-TAIL_LINES)
      .map(line => line.trim())
      .map(line => (line.length > TAIL_WIDTH ? `${line.slice(0, TAIL_WIDTH)}…` : line)),
  }
}
