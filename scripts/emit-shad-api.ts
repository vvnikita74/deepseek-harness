/**
 * Emits `shad-api/`: a committed, self-contained copy of the backend's client-facing
 * `.d.ts` closure (Remote client augmentations, `./types` exports of `packages/api/*`,
 * and the gateway stream protocol), so a separate frontend can type against the
 * Remote contracts without importing workspace packages. Requires `pnpm run build:lib`.
 *
 * `--check` emits into a temporary directory and fails when the committed tree differs.
 *
 * @module scripts/emit-shad-api
 */

import ts from 'typescript'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = join(ROOT, 'shad-api')
const SCOPE = '@deepseek-ai/'
const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2024,
}
const CACHE = ts.createModuleResolutionCache(ROOT, fileName => fileName, OPTIONS)

/** Namespace exported from `index.d.ts`, keyed by its `packages/api/<dir>` and subpath. */
const NAMESPACES = [
  ['session', 'session-controller', './types'],
  ['workspace', 'workspace-controller', './types'],
  ['workspaceFiles', 'workspace-files', './types'],
  ['terminal', 'terminal-controller', './types'],
  ['job', 'job-controller', './types'],
  ['settings', 'settings-controller', './types'],
  ['account', 'account-controller', './types'],
  ['remoteAccess', 'remote-access', './types'],
  ['jevRouter', 'jev-router', './types'],
  ['gateway', 'gateway', './stream-protocol'],
] as const

interface Manifest {
  readonly name: string
  readonly exports?: Readonly<Record<string, unknown>>
  readonly dependencies?: Readonly<Record<string, string>>
}

/**
 * Read a workspace `package.json`.
 * @param dir - absolute package directory.
 * @returns the parsed manifest.
 */
function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

/**
 * Repository-relative display path.
 * @param file - absolute path.
 * @returns the path relative to the repository root.
 */
function rel(file: string): string {
  return relative(ROOT, file).split(sep).join('/')
}

/**
 * Immediate subdirectories, sorted.
 * @param dir - absolute directory.
 * @returns absolute paths of the subdirectories.
 */
function subdirectories(dir: string): string[] {
  return readdirSync(dir).sort().map(name => join(dir, name)).filter(path => statSync(path).isDirectory())
}

/** Workspace package directories by declared name: `packages/<group>/<dir>` and `vendor/<dir>`. */
let workspaceDirs: Map<string, string> | undefined

/**
 * @returns the workspace package directory for every declared `@deepseek-ai/` name.
 */
function workspacePackageDirs(): Map<string, string> {
  if (workspaceDirs !== undefined) return workspaceDirs
  const candidates = [
    ...subdirectories(join(ROOT, 'packages')).flatMap(group => subdirectories(group)),
    ...subdirectories(join(ROOT, 'vendor')),
  ]
  workspaceDirs = new Map(candidates
    .filter(dir => existsSync(join(dir, 'package.json')))
    .map(dir => [readManifest(dir).name, dir] as const))
  return workspaceDirs
}

/**
 * Resolve one specifier with the repository's NodeNext rules (exports maps, `.ts` extensions).
 * A workspace package that a declaration imports without declaring it (so pnpm does not link it)
 * resolves from its own directory, the same way the source tree resolves it through tsconfig paths.
 * @param specifier - module specifier as written.
 * @param fromFile - absolute importing file.
 * @returns the resolved module, or undefined when it does not resolve.
 */
function resolveModule(specifier: string, fromFile: string): ts.ResolvedModuleFull | undefined {
  const direct = ts.resolveModuleName(specifier, fromFile, OPTIONS, ts.sys, CACHE).resolvedModule
  if (direct !== undefined || !specifier.startsWith(SCOPE)) return direct
  const [scope, pkg] = specifier.split('/')
  const dir = workspacePackageDirs().get(`${scope}/${pkg}`)
  return dir === undefined ? undefined : ts.resolveModuleName(specifier, join(dir, 'package.json'), OPTIONS, ts.sys, CACHE).resolvedModule
}

/**
 * Walk up from a workspace file to its owning `package.json` directory.
 * @param file - absolute workspace declaration file.
 * @returns the owning package directory.
 */
function owningPackageDir(file: string): string {
  let dir = dirname(file)
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`shad-api: no package.json owns ${rel(file)}`)
    dir = parent
  }
  return dir
}

/**
 * Map one workspace declaration file to its `shad-api/` path, dropping the package's `lib/` prefix.
 * @param file - absolute workspace `.d.ts` file.
 * @returns output path relative to `shad-api/`, e.g. `types/dsh-api-gateway/types/types.d.ts`.
 */
function outputPath(file: string): string {
  if (!file.endsWith('.d.ts')) throw new Error(`shad-api: ${rel(file)} is not a declaration file`)
  const pkgDir = owningPackageDir(file)
  const { name } = readManifest(pkgDir)
  if (!name.startsWith(SCOPE)) throw new Error(`shad-api: ${rel(file)} belongs to unscoped package ${name}`)
  let inside = relative(pkgDir, file).split(sep).join('/')
  if (inside.startsWith('lib/')) inside = inside.slice('lib/'.length)
  const out = posix.join('types', name.slice(SCOPE.length), inside)
  if (out.split('/').some(segment => segment === 'lib' || segment === 'node_modules')) {
    throw new Error(`shad-api: output path ${out} would use a lib/ or node_modules/ directory`)
  }
  return out
}

/**
 * Specifier that imports `toOut` from the file at `fromOut`, with `.js` extensions (valid under bundler and NodeNext).
 * @param fromOut - importing output path.
 * @param toOut - imported output path.
 * @returns the relative specifier.
 */
function specifierFor(fromOut: string, toOut: string): string {
  const path = posix.relative(posix.dirname(fromOut), toOut).replace(/\.d\.ts$/, '.js')
  return path.startsWith('.') ? path : `./${path}`
}

/**
 * Collect every module specifier literal of a declaration file.
 * @param sf - parsed declaration file.
 * @returns string literals naming modules: import/export declarations, `import()` types, `declare module`, `import x = require()`.
 */
function moduleSpecifiers(sf: ts.SourceFile): ts.StringLiteralLike[] {
  const found: ts.StringLiteralLike[] = []
  const visit = (node: ts.Node): void => {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
    else if (ts.isModuleDeclaration(node)) specifier = node.name
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression
    }
    if (specifier !== undefined && ts.isStringLiteral(specifier)) found.push(specifier)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Closure state: source file to output path, and the files still to rewrite. */
const copies = new Map<string, string>()
const pending: string[] = []

/**
 * Claim a workspace declaration file for copying, queuing it on first sight.
 * @param file - absolute workspace `.d.ts` file.
 * @returns its output path.
 */
function claim(file: string): string {
  const known = copies.get(file)
  if (known !== undefined) return known
  const out = outputPath(file)
  copies.set(file, out)
  pending.push(file)
  return out
}

/**
 * Rewrite workspace specifiers to relative copies, keep external ones, and strip source maps.
 * @param file - absolute source declaration file.
 * @returns the copied file text.
 */
function rewrite(file: string): string {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  if (sf.referencedFiles.length + sf.typeReferenceDirectives.length + sf.libReferenceDirectives.length > 0) {
    throw new Error(`shad-api: ${rel(file)} has a triple-slash reference the emitter does not rewrite`)
  }
  const from = copies.get(file) ?? ''
  const edits: Array<[start: number, end: number, next: string]> = []
  for (const literal of moduleSpecifiers(sf)) {
    const resolved = resolveModule(literal.text, file)
    if (resolved === undefined) throw new Error(`shad-api: "${literal.text}" in ${rel(file)} does not resolve; run pnpm run build:lib`)
    const target = resolved.resolvedFileName
    // pnpm links workspace packages through node_modules, which TypeScript flags as external; the realpath decides.
    if (target.includes(`${sep}node_modules${sep}`)) continue
    if (!target.startsWith(`${ROOT}${sep}`)) throw new Error(`shad-api: "${literal.text}" in ${rel(file)} resolves outside the repository`)
    edits.push([literal.getStart(sf) + 1, literal.end - 1, specifierFor(from, claim(target))])
  }
  let out = text
  for (const [start, end, next] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + next + out.slice(end)
  return out.replace(/\r\n?/g, '\n').split('\n').filter(line => !line.startsWith('//# sourceMappingURL=')).map(line => line.trimEnd()).join('\n').replace(/\n*$/, '\n')
}

/**
 * Resolve one entry specifier from a package's own manifest, failing loud when its build output is missing.
 * @param specifier - bare specifier to resolve.
 * @param fromFile - absolute file the specifier is resolved from.
 * @returns the absolute declaration file.
 */
function entryFile(specifier: string, fromFile: string): string {
  const resolved = resolveModule(specifier, fromFile)
  if (resolved === undefined) throw new Error(`shad-api: entry "${specifier}" does not resolve; run pnpm run build:lib`)
  return resolved.resolvedFileName
}

/**
 * Emit `shad-api/` contents into `outDir`, replacing whatever it held.
 * @param outDir - absolute target directory.
 */
export function emitShadApi(outDir: string): void {
  copies.clear()
  pending.length = 0
  const apiRoot = join(ROOT, 'packages', 'api')
  const apiDirs = subdirectories(apiRoot)
  const manifests = new Map(apiDirs.map(dir => [dir, readManifest(dir)] as const))
  for (const dir of apiDirs) {
    if (!existsSync(join(dir, 'lib', 'types'))) throw new Error(`shad-api: ${rel(dir)}/lib/types is missing; run pnpm run build:lib`)
  }

  const remoteClients = apiDirs
    .map(dir => join(dir, 'lib', 'typert.remote-client.d.ts'))
    .filter(file => existsSync(file))
  for (const file of remoteClients) claim(file)
  for (const dir of apiDirs) {
    const { name, exports } = manifests.get(dir) ?? { name: '', exports: undefined }
    for (const subpath of ['./types', './stream-protocol']) {
      if (exports?.[subpath] !== undefined) claim(entryFile(`${name}${subpath.slice(1)}`, join(dir, 'package.json')))
    }
  }
  const protocol = entryFile('@deepseek-ai/dsh-typert-protocol', join(apiRoot, 'gateway', 'package.json'))
  claim(protocol)
  const namespaceFiles = NAMESPACES.map(([alias, dir, subpath]) => {
    const dirPath = join(apiRoot, dir)
    const { name } = readManifest(dirPath)
    return [alias, claim(entryFile(`${name}${subpath.slice(1)}`, join(dirPath, 'package.json')))] as const
  })

  const zodRange = readManifest(join(ROOT, 'packages', 'typert', 'protocol')).dependencies?.zod
  if (zodRange === undefined) throw new Error('shad-api: typert-protocol no longer declares zod; update emit-shad-api.ts')

  const files = new Map<string, string>()
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    files.set(copies.get(file) ?? '', rewrite(file))
  }

  const remoteOuts = remoteClients.map(file => copies.get(file) ?? '').sort()
  const protocolOut = copies.get(protocol) ?? ''
  const index = [
    '// Generated by scripts/emit-shad-api.ts. Do not edit; run pnpm run build:shad-api.',
    `import type { RemoteResult, RemoteStreamHandle, TypertRemoteNamespaceMap } from '${specifierFor('index.d.ts', protocolOut)}'`,
    ...remoteOuts.map(out => `import '${specifierFor('index.d.ts', out)}'`),
    '',
    `export type { RemoteErrorCode, RemoteFailure, RemoteResult, RemoteStreamHandle, TypertRemoteMap, TypertRemoteNamespaceMap } from '${specifierFor('index.d.ts', protocolOut)}'`,
    ...namespaceFiles.map(([alias, out]) => `export * as ${alias} from '${specifierFor('index.d.ts', out)}'`),
    '',
    '/** One Remote method: its parameters, what it resolves to (`RemoteResult` or a stream handle), and its mode. */',
    'export type DshApiMethod<Method> = {',
    '  readonly args: Parameters<Extract<Method, (...args: never[]) => unknown>>',
    '  readonly result: Awaited<ReturnType<Extract<Method, (...args: never[]) => unknown>>>',
    '  readonly mode: Method extends (...args: never[]) => RemoteStreamHandle<unknown, unknown> ? \'stream\' : \'unary\'',
    '}',
    '',
    '/** Every Remote namespace and method, keyed `namespace -> method`, derived from the merged namespace map. */',
    'export type DshApi = {',
    '  readonly [Namespace in keyof TypertRemoteNamespaceMap]: {',
    '    readonly [Method in keyof TypertRemoteNamespaceMap[Namespace]]: DshApiMethod<TypertRemoteNamespaceMap[Namespace][Method]>',
    '  }',
    '}',
    '',
  ].join('\n')
  files.set('index.d.ts', index)
  files.set('package.json', `${JSON.stringify({
    name: '@shad-dsh/api',
    private: true,
    type: 'module',
    types: './index.d.ts',
    exports: { '.': { types: './index.d.ts' } },
    peerDependencies: { zod: zodRange },
  }, null, 2)}\n`)
  files.set('README.md', [
    '<!-- Generated by scripts/emit-shad-api.ts. Do not edit; run pnpm run build:shad-api. -->',
    '# @shad-dsh/api',
    '',
    'Backend Remote API types for the separate frontend: `DshApi`, `TypertRemoteNamespaceMap`, and the session, workspace, workspace-files, terminal, job, settings, account, remote-access and gateway stream-protocol types. Files under `types/` are copies of the backend `.d.ts` closure with workspace specifiers rewritten to relative paths.',
    '',
    'Link from the frontend: `"@shad-dsh/api": "link:../back/shad-api"`. Install the `zod` peer and set `lib` to include `ESNext.Disposable`, because `TypertOwnedValue` extends `Disposable`.',
    '',
    'Regenerate after backend API changes: `pnpm run build:lib && pnpm run build:shad-api`. Check staleness: `pnpm run verify-shad-api`.',
    '',
  ].join('\n'))

  rmSync(outDir, { recursive: true, force: true })
  for (const [out, text] of files) {
    const abs = join(outDir, out)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

/**
 * List every file under a directory as posix relative paths with content.
 * @param root - absolute directory; a missing directory lists nothing.
 * @returns relative path to text content.
 */
function listTree(root: string): Map<string, string> {
  const tree = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else tree.set(relative(root, abs).split(sep).join('/'), readFileSync(abs, 'utf8'))
    }
  }
  if (existsSync(root)) walk(root)
  return tree
}

/**
 * Compare the generated tree with the committed one.
 * @param committed - absolute committed directory.
 * @param generated - absolute freshly emitted directory.
 * @returns relative paths that are missing, extra, or different.
 */
export function staleShadApiFiles(committed: string, generated: string): string[] {
  const expected = listTree(generated)
  const actual = listTree(committed)
  const stale = new Set([...expected.keys(), ...actual.keys()])
  return [...stale].sort().filter(file => expected.get(file) !== actual.get(file))
}

/**
 * CLI entry: emit `shad-api/`, or with `--check` fail when it is stale.
 */
function main(): void {
  if (!args().includes('--check')) {
    emitShadApi(OUT)
    console.log(`shad-api: emitted ${listTree(OUT).size} files to ${rel(OUT)}`)
    return
  }
  const generated = mkdtempSync(join(tmpdir(), 'shad-api-check-'))
  try {
    emitShadApi(generated)
    const stale = staleShadApiFiles(OUT, generated)
    if (stale.length > 0) {
      console.error(`shad-api is stale; run pnpm run build:shad-api:\n${stale.map(file => `  ${file}`).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`shad-api is up to date (${listTree(OUT).size} files)`)
    }
  } finally {
    rmSync(generated, { recursive: true, force: true })
  }
}

/**
 * Command-line arguments after the script path.
 * @returns the raw argument list.
 */
function args(): string[] {
  return process.argv.slice(2)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
