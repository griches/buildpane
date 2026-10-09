import type { Run } from '../types'
import { commands } from './shell'

export type Invocation = {
  /** Which toolchain's output to expect: decides the rules only that toolchain needs. */
  tool: string
  label: string
  kind: Run['kind']
}

const SCRIPT = /(^|[:_.-])(build|tests?|lint|check|typecheck|type-check|types|tsc|compile|verify|ci)($|[:_.-])/
const TEST_SCRIPT = /(^|[:_.-])tests?($|[:_.-])/
const LINT_SCRIPT = /(^|[:_.-])(lint|check|typecheck|type-check|types|tsc)($|[:_.-])/
const PASSES_ON = new Set(['npx', 'bunx', 'pnpx', 'uvx'])
const RUNS_REST = new Map([
  ['pnpm', new Set(['exec', 'dlx'])],
  ['yarn', new Set(['exec', 'dlx'])],
  ['bun', new Set(['x'])],
  ['uv', new Set(['run'])],
  ['poetry', new Set(['run'])],
  ['pipenv', new Set(['run'])],
  ['hatch', new Set(['run'])],
  ['bundle', new Set(['exec'])],
  ['dotenv', new Set(['--'])],
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const OFF_FLAGS = new Set(['--help', '-h', '--version', '-V', '--watch', '-w', '--init', '--showConfig', '--listFiles'])
const CARGO = new Map<string, Run['kind']>([
  ['build', 'build'],
  ['b', 'build'],
  ['check', 'build'],
  ['c', 'build'],
  ['clippy', 'lint'],
  ['test', 'test'],
  ['t', 'test'],
  ['nextest', 'test'],
  ['bench', 'test'],
  ['doc', 'build'],
])
const GO = new Map<string, Run['kind']>([
  ['build', 'build'],
  ['vet', 'lint'],
  ['test', 'test'],
  ['install', 'build'],
])
const DOTNET = new Map<string, Run['kind']>([
  ['build', 'build'],
  ['test', 'test'],
  ['publish', 'build'],
])
const SINGLE = new Map<string, { tool: string; kind: Run['kind'] }>([
  ['tsc', { tool: 'tsc', kind: 'build' }],
  ['vue-tsc', { tool: 'tsc', kind: 'build' }],
  ['tsgo', { tool: 'tsc', kind: 'build' }],
  ['eslint', { tool: 'eslint', kind: 'lint' }],
  ['pytest', { tool: 'pytest', kind: 'test' }],
  ['py.test', { tool: 'pytest', kind: 'test' }],
  ['tox', { tool: 'pytest', kind: 'test' }],
  ['nox', { tool: 'pytest', kind: 'test' }],
  ['jest', { tool: 'jest', kind: 'test' }],
  ['vitest', { tool: 'vitest', kind: 'test' }],
  ['mypy', { tool: 'mypy', kind: 'lint' }],
  ['pyright', { tool: 'pyright', kind: 'lint' }],
  ['basedpyright', { tool: 'pyright', kind: 'lint' }],
  ['gradle', { tool: 'gradle', kind: 'build' }],
  ['gradlew', { tool: 'gradle', kind: 'build' }],
  ['mvn', { tool: 'maven', kind: 'build' }],
  ['mvnw', { tool: 'maven', kind: 'build' }],
  ['make', { tool: 'make', kind: 'build' }],
  ['gmake', { tool: 'make', kind: 'build' }],
  ['ninja', { tool: 'make', kind: 'build' }],
  ['gcc', { tool: 'make', kind: 'build' }],
  ['g++', { tool: 'make', kind: 'build' }],
  ['cc', { tool: 'make', kind: 'build' }],
  ['clang', { tool: 'make', kind: 'build' }],
  ['clang++', { tool: 'make', kind: 'build' }],
  ['rustc', { tool: 'cargo', kind: 'build' }],
  ['javac', { tool: 'gradle', kind: 'build' }],
  ['kotlinc', { tool: 'gradle', kind: 'build' }],
])
const GRADLE_OFF = new Set(['tasks', 'help', 'projects', 'properties', 'dependencies', 'wrapper', 'init', '--stop', '--status'])
const TEST_TASK = /(^|:)(test|check|connected\w*Test|\w+Test)$/i

const words = (args: readonly string[]) => args.filter(one => !one.startsWith('-'))

const script = (manager: string, name: string): Invocation | null =>
  SCRIPT.test(name)
    ? {
        tool: 'script',
        label: `${manager} ${name === 'test' ? 'test' : `run ${name}`}`,
        kind: TEST_SCRIPT.test(name) ? 'test' : LINT_SCRIPT.test(name) ? 'lint' : 'build',
      }
    : null

const packageManager = (name: string, args: readonly string[]): Invocation | null => {
  const [verb, target] = words(args)

  if (verb === undefined) {
    return null
  }

  if (verb === 'test' || verb === 't') {
    return name === 'bun' ? { tool: 'bun', label: 'bun test', kind: 'test' } : script(name, 'test')
  }

  if (verb === 'run' || verb === 'run-script') {
    return target === undefined ? null : script(name, target)
  }

  // pnpm, yarn and bun run a script named as the verb; npm does not.
  return name === 'npm' ? null : script(name, verb)
}

const resolve = (name: string, args: readonly string[], depth = 0): Invocation | null => {
  if (depth > 3 || args.some(one => OFF_FLAGS.has(one))) {
    return null
  }

  const [verb] = words(args)
  const rest = () => {
    const at = verb === undefined ? -1 : args.indexOf(verb)
    const next = args.slice(at + 1)
    const [head] = words(next)

    return head === undefined ? null : resolve(basename(head), next.slice(next.indexOf(head) + 1), depth + 1)
  }

  if (PASSES_ON.has(name)) {
    return verb === undefined ? null : resolve(basename(verb), args.slice(args.indexOf(verb) + 1), depth + 1)
  }

  if (verb !== undefined && RUNS_REST.get(name)?.has(verb) === true) {
    return rest()
  }

  if (/^python[\d.]*$/.test(name) && args[0] === '-m' && args[1] !== undefined) {
    return resolve(args[1], args.slice(2), depth + 1)
  }

  if (PACKAGE_MANAGERS.has(name)) {
    return packageManager(name, args)
  }

  if (name === 'cargo') {
    // `cargo +nightly test`: the toolchain comes before the verb.
    const kind = CARGO.get((verb?.startsWith('+') === true ? words(args)[1] : verb) ?? '')

    return kind === undefined ? null : { tool: 'cargo', label: `cargo ${words(args).filter(one => !one.startsWith('+'))[0]}`, kind }
  }

  if (name === 'go') {
    const kind = GO.get(verb ?? '')

    return kind === undefined ? null : { tool: 'go', label: `go ${verb}`, kind }
  }

  if (name === 'dotnet') {
    const kind = DOTNET.get(verb ?? '')

    return kind === undefined ? null : { tool: 'dotnet', label: `dotnet ${verb}`, kind }
  }

  if (name === 'ruff') {
    return verb === 'check' ? { tool: 'ruff', label: 'ruff check', kind: 'lint' } : null
  }

  if (name === 'cmake') {
    return args.includes('--build') ? { tool: 'make', label: 'cmake --build', kind: 'build' } : null
  }

  const single = SINGLE.get(name)

  if (single === undefined) {
    return null
  }

  if (single.tool === 'gradle' || single.tool === 'maven') {
    const tasks = words(args)

    if (tasks.length === 0 || tasks.some(one => GRADLE_OFF.has(one)) || args.some(one => GRADLE_OFF.has(one))) {
      return null
    }

    const hasTests = tasks.some(one => TEST_TASK.test(one) || one === 'verify')

    return { tool: single.tool, label: `${name} ${tasks.slice(0, 2).join(' ')}`, kind: hasTests ? 'test' : 'build' }
  }

  return { ...single, label: name }
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * The builds, test runs and lint runs a Bash command starts, in order.
 *
 * `xcodebuild` and `swift build` are left out on purpose: xcpane reads those
 * from Xcode's result bundle, which says more than the log does.
 */
export const findInvocations = (command: string): Invocation[] =>
  commands(command)
    .map(one => resolve(one.name, one.args))
    .filter(one => one !== null)

/** Commands that print nothing of their own, or only pass on what the build printed. */
const PASSIVE = new Set([
  'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'source', '.', 'true', ':', 'mkdir', 'touch', 'rm', 'sleep', 'wait',
  'tail', 'head', 'grep', 'egrep', 'rg', 'tee', 'sort', 'uniq', 'cut', 'awk', 'wc', 'tr', 'less', 'more', 'column',
])

/**
 * The other commands of a line whose own output Claude may be after: `cat src/a.ts && tsc`
 * prints a file as well as a build, so that line's output is not replaced by a summary.
 */
export const mixedWith = (command: string): string[] =>
  commands(command)
    .filter(one => resolve(one.name, one.args) === null)
    .filter(one => !PASSIVE.has(one.name) && !((one.name === 'cat' || one.name === 'sed') && one.args.every(arg => arg.startsWith('-') || one.name === 'sed')))
    .map(one => one.name)
