import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { emitShadApi } from './emit-shad-api.ts'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLER: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2024,
}

/**
 * Absolute declaration file a bare specifier resolves to from a repository file.
 * @param specifier - bare module specifier.
 * @param fromFile - repository file the specifier is resolved from.
 * @returns the resolved declaration file.
 */
function resolvedFile(specifier: string, fromFile: string): string {
  const resolved = ts.resolveModuleName(specifier, fromFile, BUNDLER, ts.sys).resolvedModule
  if (resolved === undefined) throw new Error(`${specifier} does not resolve from ${fromFile}`)
  return resolved.resolvedFileName
}

/**
 * Compile one probe module against an emitted `shad-api/` under strict bundler settings.
 * The front's own `zod` and `@standard-schema/spec` come from the repository node_modules through `paths`.
 * @param body - probe module source, importing from `../shad-api/index.js`.
 * @returns formatted diagnostics; empty when the probe type-checks.
 */
function compileProbe(body: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'shad-api-fixture-'))
  try {
    emitShadApi(join(dir, 'shad-api'))
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'app', 'main.ts'), body)
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        moduleResolution: 'bundler',
        module: 'esnext',
        target: 'es2024',
        lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
        noEmit: true,
        types: [],
        paths: {
          zod: [resolvedFile('zod', join(ROOT, 'packages/typert/protocol/package.json'))],
          '@standard-schema/spec': [resolvedFile('@standard-schema/spec', join(ROOT, 'vendor/schemastery/package.json'))],
        },
      },
      files: ['app/main.ts'],
    }))
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(dir, 'tsconfig.json'), file => ts.sys.readFile(file)).config, ts.sys, dir)
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const where = diagnostic.file === undefined ? '' : `${diagnostic.file.fileName.slice(dir.length + 1)}: `
      return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SAME = 'type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false'

describe('emit-shad-api', () => {
  it('emitted shad-api type-checks under strict bundler settings with zero diagnostics', () => {
    const diagnostics = compileProbe(`import type { DshApi, TypertRemoteNamespaceMap, session } from '../shad-api/index.js'
${SAME}
export const sessionPromptArgs: Same<DshApi['session']['prompt']['args'][0], session.SessionPromptRequest> = true
export const followIsStream: DshApi['session']['follow']['mode'] = 'stream'
export const sessionNamespace: 'session' extends keyof TypertRemoteNamespaceMap ? true : false = true
`)
    expect(diagnostics).toEqual([])
  }, 120_000)

  it('rejects a wrong use of the emitted types, so the zero-diagnostics result is not vacuous', () => {
    const diagnostics = compileProbe(`import type { DshApi } from '../shad-api/index.js'
export const followIsUnary: DshApi['session']['follow']['mode'] = 'unary'
`)
    expect(diagnostics).toHaveLength(1)
  }, 120_000)
})
