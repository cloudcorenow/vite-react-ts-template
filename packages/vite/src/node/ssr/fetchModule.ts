import { pathToFileURL } from 'node:url'
import type { FetchResult } from 'vite/module-runner'
import type { EnvironmentModuleNode, TransformResult } from '..'
import type { InternalResolveOptionsWithOverrideConditions } from '../plugins/resolve'
import { tryNodeResolve } from '../plugins/resolve'
import { isBuiltin, isExternalUrl, isFilePathESM } from '../utils'
import { unwrapId } from '../../shared/utils'
import {
  MODULE_RUNNER_SOURCEMAPPING_SOURCE,
  SOURCEMAPPING_URL,
} from '../../shared/constants'
import { genSourceMapUrl } from '../server/sourcemap'
import type { DevEnvironment } from '../server/environment'

export interface FetchModuleOptions {
  inlineSourceMap?: boolean
  processSourceMap?<T extends NonNullable<TransformResult['map']>>(map: T): T
}

/**
 * Fetch module information for Vite runner.
 * @experimental
 */
export async function fetchModule(
  environment: DevEnvironment,
  url: string,
  importer?: string,
  options: FetchModuleOptions = {},
): Promise<FetchResult> {
  // builtins should always be externalized
  if (url.startsWith('data:') || isBuiltin(url)) {
    return { externalize: url, type: 'builtin' }
  }

  if (isExternalUrl(url)) {
    return { externalize: url, type: 'network' }
  }

  if (url[0] !== '.' && url[0] !== '/') {
    const {
      isProduction,
      resolve: { dedupe, preserveSymlinks },
      root,
      ssr,
    } = environment.config
    const externalConditions = ssr.resolve?.externalConditions || []

    const resolveOptions: InternalResolveOptionsWithOverrideConditions = {
      mainFields: ['main'],
      conditions: [],
      externalConditions,
      external: [], // TODO, should it be ssr.resolve.external?
      noExternal: [],
      overrideConditions: [...externalConditions, 'production', 'development'],
      extensions: ['.js', '.cjs', '.json'],
      dedupe,
      preserveSymlinks,
      isBuild: false,
      isProduction,
      root,
      ssrConfig: ssr,
      packageCache: environment.config.packageCache,
    }

    const resolved = tryNodeResolve(
      url,
      importer,
      {
        ...resolveOptions,
        tryEsmOnly: true,
        webCompatible: environment.options.webCompatible,
        nodeCompatible: environment.options.nodeCompatible,
      },
      undefined,
      true,
    )
    if (!resolved) {
      const err: any = new Error(
        `Cannot find module '${url}' imported from '${importer}'`,
      )
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    const file = pathToFileURL(resolved.id).toString()
    const type = isFilePathESM(resolved.id, environment.config.packageCache)
      ? 'module'
      : 'commonjs'
    return { externalize: file, type }
  }

  url = unwrapId(url)

  let result = await environment.transformRequest(url)

  if (!result) {
    throw new Error(
      `[vite] transform failed for module '${url}'${
        importer ? ` imported from '${importer}'` : ''
      }.`,
    )
  }

  // module entry should be created by transformRequest
  const mod = await environment.moduleGraph.getModuleByUrl(url)

  if (!mod) {
    throw new Error(
      `[vite] cannot find module '${url}' ${
        importer ? ` imported from '${importer}'` : ''
      }.`,
    )
  }

  if (options.inlineSourceMap !== false) {
    result = inlineSourceMap(mod, result, options.processSourceMap)
  }

  // remove shebang
  if (result.code[0] === '#')
    result.code = result.code.replace(/^#!.*/, (s) => ' '.repeat(s.length))

  return { code: result.code, file: mod.file }
}

const OTHER_SOURCE_MAP_REGEXP = new RegExp(
  `//# ${SOURCEMAPPING_URL}=data:application/json[^,]+base64,([A-Za-z0-9+/=]+)$`,
  'gm',
)

function inlineSourceMap(
  mod: EnvironmentModuleNode,
  result: TransformResult,
  processSourceMap?: FetchModuleOptions['processSourceMap'],
) {
  const map = result.map
  let code = result.code

  if (
    !map ||
    !('version' in map) ||
    code.includes(MODULE_RUNNER_SOURCEMAPPING_SOURCE)
  )
    return result

  // to reduce the payload size, we only inline vite node source map, because it's also the only one we use
  OTHER_SOURCE_MAP_REGEXP.lastIndex = 0
  if (OTHER_SOURCE_MAP_REGEXP.test(code))
    code = code.replace(OTHER_SOURCE_MAP_REGEXP, '')

  const sourceMap = processSourceMap?.(map) || map
  result.code = `${code.trimEnd()}\n//# sourceURL=${
    mod.id
  }\n${MODULE_RUNNER_SOURCEMAPPING_SOURCE}\n//# ${SOURCEMAPPING_URL}=${genSourceMapUrl(sourceMap)}\n`

  return result
}
