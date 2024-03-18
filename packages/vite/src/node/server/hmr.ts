import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import colors from 'picocolors'
import type { CustomPayload, HMRPayload, Update } from 'types/hmrPayload'
import type { RollupError } from 'rollup'
import { CLIENT_DIR } from '../constants'
import type { ResolvedConfig } from '../config'
import { createDebugger, normalizePath, unique } from '../utils'
import type { InferCustomEventPayload, ViteDevServer } from '..'
import { getHookHandler } from '../plugins'
import { isCSSRequest } from '../plugins/css'
import { getAffectedGlobModules } from '../plugins/importMetaGlob'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import { getEnvFilesForMode } from '../env'
import { withTrailingSlash, wrapId } from '../../shared/utils'
import type { Plugin } from '../plugin'
import type { EnvironmentModuleNode, ModuleNode } from './moduleGraph'
import type { DevEnvironment } from './environment'
import { restartServerWithUrls } from '.'

export const debugHmr = createDebugger('vite:hmr')

const whitespaceRE = /\s/

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  overlay?: boolean
  server?: Server
  /** @internal */
  channels?: HMRChannel[]
}

export interface HotUpdateContext {
  file: string
  timestamp: number
  modules: Array<EnvironmentModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
  environment: DevEnvironment
}

/**
 * @deprecated
 * Used by handleHotUpdate for backward compatibility with mixed client and ssr moduleGraph
 **/
export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

interface PropagationBoundary {
  boundary: EnvironmentModuleNode
  acceptedVia: EnvironmentModuleNode
  isWithinCircularImport: boolean
}

export interface HMRBroadcasterClient {
  /**
   * Send event to the client
   */
  send(payload: HMRPayload): void
  /**
   * Send custom event
   */
  send(event: string, payload?: CustomPayload['data']): void
}

export interface HMRChannel {
  /**
   * Unique channel name
   */
  name: string
  /**
   * Broadcast events to all clients
   */
  send(payload: HMRPayload): void
  /**
   * Send custom event
   */
  send<T extends string>(event: T, payload?: InferCustomEventPayload<T>): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on<T extends string>(
    event: T,
    listener: (
      data: InferCustomEventPayload<T>,
      client: HMRBroadcasterClient,
      ...args: any[]
    ) => void,
  ): void
  on(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off(event: string, listener: Function): void
  /**
   * Start listening for messages
   */
  listen(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close(): void
}

export interface HMRBroadcaster extends Omit<HMRChannel, 'close' | 'name'> {
  /**
   * All registered channels. Always has websocket channel.
   */
  readonly channels: HMRChannel[]
  /**
   * Add a new third-party channel.
   */
  addChannel(connection: HMRChannel): HMRBroadcaster
  close(): Promise<unknown[]>
}

export function getShortName(file: string, root: string): string {
  return file.startsWith(withTrailingSlash(root))
    ? path.posix.relative(root, file)
    : file
}

export function getSortedPluginsByHotUpdateHook(
  plugins: readonly Plugin[],
): Plugin[] {
  const sortedPlugins: Plugin[] = []
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) {
    const hook = plugin['hotUpdate'] ?? plugin['handleHotUpdate']
    if (hook) {
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  return sortedPlugins
}

const sortedHotUpdatePluginsCache = new WeakMap<ResolvedConfig, Plugin[]>()
function getSortedHotUpdatePlugins(config: ResolvedConfig): Plugin[] {
  let sortedPlugins = sortedHotUpdatePluginsCache.get(config) as Plugin[]
  if (!sortedPlugins) {
    sortedPlugins = getSortedPluginsByHotUpdateHook(config.plugins)
    sortedHotUpdatePluginsCache.set(config, sortedPlugins)
  }
  return sortedPlugins
}

export interface HmrTask {
  environment: DevEnvironment
  run: () => Promise<void>
  cancel: () => void
}

export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer,
  configOnly: boolean,
): Promise<void> {
  const { hot, config } = server
  const shortFile = getShortName(file, config.root)

  const isConfig = file === config.configFile
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name,
  )

  const isEnv =
    config.inlineConfig.envFile !== false &&
    getEnvFilesForMode(config.mode, config.envDir).includes(file)
  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`,
      ),
      { clear: true, timestamp: true },
    )
    try {
      await restartServerWithUrls(server)
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  if (configOnly) {
    return
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`)

  // (dev only) the client itself cannot be hot updated.
  if (file.startsWith(withTrailingSlash(normalizedClientDir))) {
    hot.send({
      type: 'full-reload',
      path: '*',
      triggeredBy: path.resolve(config.root, file),
    })
    return
  }

  // TODO: We should do everything that is here until the end of the function
  // for each moduleGraph once SSR is updated to support separate moduleGraphs
  // getSSRInvalidatedImporters should be removed.
  // The compat hook handleHotUpdate should only be called for the browser
  // For now, we only call updateModules for the browser. Later on it should
  // also be called for each runtime.

  async function applyHMR(environment: DevEnvironment) {
    const mods = environment.moduleGraph.getModulesByFile(file)

    // check if any plugin wants to perform custom HMR handling
    const timestamp = Date.now()
    const hotContext: HotUpdateContext = {
      file,
      timestamp,
      modules: mods ? [...mods] : [],
      read: () => readModifiedFile(file),
      server,
      // later on hotUpdate will be called for each runtime with a new hotContext
      environment,
    }

    let hmrContext

    for (const plugin of getSortedHotUpdatePlugins(config)) {
      if (plugin.hotUpdate) {
        const filteredModules = await getHookHandler(plugin.hotUpdate)(
          hotContext,
        )
        if (filteredModules) {
          hotContext.modules = filteredModules
          // Invalidate the hmrContext to force compat modules to be updated
          hmrContext = undefined
        }
      } else if (environment.name === 'browser') {
        // later on, we'll need: if (runtime === 'browser')
        // Backward compatibility with mixed client and ssr moduleGraph
        hmrContext ??= {
          ...hotContext,
          modules: hotContext.modules.map((mod) =>
            server.moduleGraph.getBackwardCompatibleModuleNode(mod),
          ),
        } as HmrContext
        const filteredModules = await getHookHandler(plugin.handleHotUpdate!)(
          hmrContext,
        )
        if (filteredModules) {
          hmrContext.modules = filteredModules
          hotContext.modules = filteredModules
            .map((mod) =>
              mod.id
                ? server.browserEnvironment.moduleGraph.getModuleById(mod.id) ??
                  server.ssrEnvironment.moduleGraph.getModuleById(mod.id)
                : undefined,
            )
            .filter(Boolean) as EnvironmentModuleNode[]
        }
      }
    }

    if (!hotContext.modules.length) {
      // html file cannot be hot updated
      if (file.endsWith('.html')) {
        config.logger.info(
          colors.green(`page reload `) + colors.dim(shortFile),
          {
            clear: true,
            timestamp: true,
          },
        )
        hot.send({
          type: 'full-reload',
          path: config.server.middlewareMode
            ? '*'
            : '/' + normalizePath(path.relative(config.root, file)),
        })
      } else {
        // loaded but not in the module graph, probably not js
        debugHmr?.(`[no modules matched] ${colors.dim(shortFile)}`)
      }
      return
    }

    updateModules(environment, shortFile, hotContext.modules, timestamp, server)
  }

  const hmrTasks: HmrTask[] = []
  for (const environment of server.environments) {
    hmrTasks.push({
      environment,
      run: () => applyHMR(environment),
      cancel: () => {}, // TODO: implement cancel, maybe it isn't needed
    })
  }

  const runHmrTasks =
    server.config.server.runHmrTasks ??
    ((server, hmrTasks) => {
      // Run HMR in parallel for all environments by default
      return Promise.all(hmrTasks.map((task) => task.run()))
    })

  await runHmrTasks(server, hmrTasks)
}

type HasDeadEnd = boolean

export function updateModules(
  environment: DevEnvironment,
  file: string,
  modules: EnvironmentModuleNode[],
  timestamp: number,
  server: ViteDevServer,
  afterInvalidation?: boolean,
): void {
  const { config, hot } = server
  const updates: Update[] = []
  const invalidatedModules = new Set<EnvironmentModuleNode>()
  const traversedModules = new Set<EnvironmentModuleNode>()
  let needFullReload: HasDeadEnd = false

  for (const mod of modules) {
    const boundaries: PropagationBoundary[] = []
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    environment.moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
    )

    if (needFullReload) {
      continue
    }

    if (hasDeadEnd) {
      needFullReload = hasDeadEnd
      continue
    }

    updates.push(
      ...boundaries.map(
        ({ boundary, acceptedVia, isWithinCircularImport }) => ({
          type: `${boundary.type}-update` as const,
          timestamp,
          path: normalizeHmrUrl(boundary.url),
          acceptedPath: normalizeHmrUrl(acceptedVia.url),
          explicitImportRequired:
            boundary.type === 'js'
              ? isExplicitImportRequired(acceptedVia.url)
              : false,
          isWithinCircularImport,
          // browser modules are invalidated by changing ?t= query,
          // but in ssr we control the module system, so we can directly remove them form cache
          ssrInvalidates: getSSRInvalidatedImporters(acceptedVia),
        }),
      ),
    )
  }

  if (needFullReload) {
    const reason =
      typeof needFullReload === 'string'
        ? colors.dim(` (${needFullReload})`)
        : ''
    config.logger.info(
      colors.green(`page reload `) + colors.dim(file) + reason,
      { clear: !afterInvalidation, timestamp: true },
    )
    hot.send({
      type: 'full-reload',
      triggeredBy: path.resolve(config.root, file),
    })
    return
  }

  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  config.logger.info(
    colors.green(`hmr update `) +
      colors.dim([...new Set(updates.map((u) => u.path))].join(', ')),
    { clear: !afterInvalidation, timestamp: true },
  )
  hot.send({
    type: 'update',
    updates,
  })
}

function populateSSRImporters(
  module: EnvironmentModuleNode,
  timestamp: number,
  seen: Set<EnvironmentModuleNode> = new Set(),
) {
  module.importedModules.forEach((importer) => {
    if (seen.has(importer)) {
      return
    }
    if (
      importer.lastHMRTimestamp === timestamp ||
      importer.lastInvalidationTimestamp === timestamp
    ) {
      seen.add(importer)
      populateSSRImporters(importer, timestamp, seen)
    }
  })
  return seen
}

function getSSRInvalidatedImporters(module: EnvironmentModuleNode) {
  return [...populateSSRImporters(module, module.lastHMRTimestamp)].map(
    (m) => m.file!,
  )
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer,
  isUnlink: boolean,
): Promise<void> {
  server.environments.forEach((environment) => {
    const modules = [...(environment.moduleGraph.getModulesByFile(file) || [])]

    if (isUnlink) {
      for (const deletedMod of modules) {
        deletedMod.importedModules.forEach((importedMod) => {
          importedMod.importers.delete(deletedMod)
        })
      }
    }

    modules.push(...getAffectedGlobModules(file, server))

    if (modules.length > 0) {
      updateModules(
        environment,
        getShortName(file, server.config.root),
        unique(modules),
        Date.now(),
        server,
      )
    }
  })
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

function propagateUpdate(
  node: EnvironmentModuleNode,
  traversedModules: Set<EnvironmentModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: EnvironmentModuleNode[] = [node],
): HasDeadEnd {
  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id,
      )}`,
    )
    return false
  }

  if (node.isSelfAccepting) {
    boundaries.push({
      boundary: node,
      acceptedVia: node,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })

    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer),
        )
      }
    }

    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) {
    boundaries.push({
      boundary: node,
      acceptedVia: node,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
  } else {
    if (!node.importers.size) {
      return true
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)

    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.push({
        boundary: importer,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (
      !currentChain.includes(importer) &&
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      return true
    }
  }
  return false
}

/**
 * Check importers recursively if it's an import loop. An accepted module within
 * an import loop cannot recover its execution order and should be reloaded.
 *
 * @param node The node that accepts HMR and is a boundary
 * @param nodeChain The chain of nodes/imports that lead to the node.
 *   (The last node in the chain imports the `node` parameter)
 * @param currentChain The current chain tracked from the `node` parameter
 * @param traversedModules The set of modules that have traversed
 */
function isNodeWithinCircularImports(
  node: EnvironmentModuleNode,
  nodeChain: EnvironmentModuleNode[],
  currentChain: EnvironmentModuleNode[] = [node],
  traversedModules = new Set<EnvironmentModuleNode>(),
): boolean {
  // To help visualize how each parameters work, imagine this import graph:
  //
  // A -> B -> C -> ACCEPTED -> D -> E -> NODE
  //      ^--------------------------|
  //
  // ACCEPTED: the node that accepts HMR. the `node` parameter.
  // NODE    : the initial node that triggered this HMR.
  //
  // This function will return true in the above graph, which:
  // `node`         : ACCEPTED
  // `nodeChain`    : [NODE, E, D, ACCEPTED]
  // `currentChain` : [ACCEPTED, C, B]
  //
  // It works by checking if any `node` importers are within `nodeChain`, which
  // means there's an import loop with a HMR-accepted module in it.

  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  for (const importer of node.importers) {
    // Node may import itself which is safe
    if (importer === node) continue

    // a PostCSS plugin like Tailwind JIT may register
    // any file as a dependency to a CSS file.
    // But in that case, the actual dependency chain is separate.
    if (isCSSRequest(importer.url)) continue

    // Check circular imports
    const importerIndex = nodeChain.indexOf(importer)
    if (importerIndex > -1) {
      // Log extra debug information so users can fix and remove the circular imports
      if (debugHmr) {
        // Following explanation above:
        // `importer`                    : E
        // `currentChain` reversed       : [B, C, ACCEPTED]
        // `nodeChain` sliced & reversed : [D, E]
        // Combined                      : [E, B, C, ACCEPTED, D, E]
        const importChain = [
          importer,
          ...[...currentChain].reverse(),
          ...nodeChain.slice(importerIndex, -1).reverse(),
        ]
        debugHmr(
          colors.yellow(`circular imports detected: `) +
            importChain.map((m) => colors.dim(m.url)).join(' -> '),
        )
      }
      return true
    }

    // Continue recursively
    if (!currentChain.includes(importer)) {
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        currentChain.concat(importer),
        traversedModules,
      )
      if (result) return result
    }
  }
  return false
}

export function handlePrunedModules(
  mods: Set<EnvironmentModuleNode>,
  { hot }: ViteDevServer,
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`)
  })
  hot.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>,
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== '.' && url[0] !== '/') {
    url = wrapId(url)
  }
  return url
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`,
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, 'utf-8')
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs

    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10))
      const newMtime = (await fsp.stat(file)).mtimeMs
      if (newMtime !== mtime) {
        break
      }
    }

    return await fsp.readFile(file, 'utf-8')
  } else {
    return content
  }
}

export function createHMRBroadcaster(): HMRBroadcaster {
  const channels: HMRChannel[] = []
  const readyChannels = new WeakSet<HMRChannel>()
  const broadcaster: HMRBroadcaster = {
    get channels() {
      return [...channels]
    },
    addChannel(channel) {
      if (channels.some((c) => c.name === channel.name)) {
        throw new Error(`HMR channel "${channel.name}" is already defined.`)
      }
      channels.push(channel)
      return broadcaster
    },
    on(event: string, listener: (...args: any[]) => any) {
      // emit connection event only when all channels are ready
      if (event === 'connection') {
        // make a copy so we don't wait for channels that might be added after this is triggered
        const channels = this.channels
        channels.forEach((channel) =>
          channel.on('connection', () => {
            readyChannels.add(channel)
            if (channels.every((c) => readyChannels.has(c))) {
              listener()
            }
          }),
        )
        return
      }
      channels.forEach((channel) => channel.on(event, listener))
      return
    },
    off(event, listener) {
      channels.forEach((channel) => channel.off(event, listener))
      return
    },
    send(...args: any[]) {
      channels.forEach((channel) => channel.send(...(args as [any])))
    },
    listen() {
      channels.forEach((channel) => channel.listen())
    },
    close() {
      return Promise.all(channels.map((channel) => channel.close()))
    },
  }
  return broadcaster
}

export interface ServerHMRChannel extends HMRChannel {
  api: {
    innerEmitter: EventEmitter
    outsideEmitter: EventEmitter
  }
}

export function createServerHMRChannel(): ServerHMRChannel {
  const innerEmitter = new EventEmitter()
  const outsideEmitter = new EventEmitter()

  return {
    name: 'ssr',
    send(...args: any[]) {
      let payload: HMRPayload
      if (typeof args[0] === 'string') {
        payload = {
          type: 'custom',
          event: args[0],
          data: args[1],
        }
      } else {
        payload = args[0]
      }
      outsideEmitter.emit('send', payload)
    },
    off(event, listener: () => void) {
      innerEmitter.off(event, listener)
    },
    on: ((event: string, listener: () => unknown) => {
      innerEmitter.on(event, listener)
    }) as ServerHMRChannel['on'],
    close() {
      innerEmitter.removeAllListeners()
      outsideEmitter.removeAllListeners()
    },
    listen() {
      innerEmitter.emit('connection')
    },
    api: {
      innerEmitter,
      outsideEmitter,
    },
  }
}

export function createNoopHMRChannel(): HMRChannel {
  function noop() {
    // noop
  }

  return {
    name: 'noop',
    send: noop,
    on: noop,
    off: noop,
    listen: noop,
    close: noop,
  }
}
