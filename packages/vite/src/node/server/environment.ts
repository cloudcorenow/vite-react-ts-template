import type { FetchResult } from 'vite/module-runner'
import colors from 'picocolors'
import { Environment } from '../environment'
import type { ViteDevServer } from '../server'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import type { EnvironmentOptions, ResolvedEnvironmentOptions } from '../config'
import { getDefaultResolvedEnvironmentOptions } from '../config'
import { mergeConfig } from '../utils'
import type { FetchModuleOptions } from '../ssr/fetchModule'
import { fetchModule } from '../ssr/fetchModule'
import {
  createDepsOptimizer,
  createExplicitDepsOptimizer,
} from '../optimizer/optimizer'
import type { DepsOptimizer } from '../optimizer'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { HMRChannel } from './hmr'
import { createNoopHMRChannel, getShortName, updateModules } from './hmr'
import { transformRequest } from './transformRequest'
import type { TransformResult } from './transformRequest'
import { ERR_CLOSED_SERVER } from './pluginContainer'
import type { RemoteEnvironmentTransport } from './environmentTransport'

export interface DevEnvironmentSetup {
  hot?: false | HMRChannel
  options?: EnvironmentOptions
  runner?: FetchModuleOptions & {
    transport?: RemoteEnvironmentTransport
  }
}

// Maybe we will rename this to DevEnvironment
export class DevEnvironment extends Environment {
  mode = 'dev' as const // TODO: should this be 'serve'?
  moduleGraph: EnvironmentModuleGraph
  server: ViteDevServer
  depsOptimizer?: DepsOptimizer
  /**
   * @internal
   */
  _ssrRunnerOptions: FetchModuleOptions | undefined
  /**
   * HMR channel for this environment. If not provided or disabled,
   * it will be a noop channel that does nothing.
   *
   * @example
   * environment.hot.send({ type: 'full-reload' })
   */
  hot: HMRChannel
  constructor(
    server: ViteDevServer,
    name: string,
    setup?: {
      hot?: false | HMRChannel
      options?: EnvironmentOptions
      runner?: FetchModuleOptions & {
        transport?: RemoteEnvironmentTransport
      }
      depsOptimizer?: DepsOptimizer
    },
  ) {
    let options =
      server.config.environments[name] ??
      getDefaultResolvedEnvironmentOptions(server.config)
    if (setup?.options) {
      options = mergeConfig(
        options,
        setup?.options,
      ) as ResolvedEnvironmentOptions
    }
    super(name, server.config, options)

    this.server = server
    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) =>
      this.server.pluginContainer.resolveId(url, undefined, {
        environment: this,
      }),
    )
    this.hot = setup?.hot || createNoopHMRChannel()

    const ssrRunnerOptions = setup?.runner || {}
    this._ssrRunnerOptions = ssrRunnerOptions
    setup?.runner?.transport?.register(this)

    this.hot.on('vite:invalidate', async ({ path, message }) => {
      invalidateModule(this, {
        path,
        message,
      })
    })

    const { optimizeDeps } = this.options.dev
    if (setup?.depsOptimizer) {
      this.depsOptimizer = setup?.depsOptimizer
    } else if (
      optimizeDeps?.noDiscovery &&
      optimizeDeps?.include?.length === 0
    ) {
      this.depsOptimizer = undefined
    } else {
      // We only support auto-discovery for the client environment, for all other
      // environments `noDiscovery` has no effect and an simpler explicit deps
      // optimizer is used that only optimizes explicitely included dependencies
      // so it doesn't need to reload the environment. Now that we have proper HMR
      // and full reload for general environments, we can enable autodiscovery for
      // them in the future
      this.depsOptimizer = (
        optimizeDeps.noDiscovery || name !== 'client'
          ? createExplicitDepsOptimizer
          : createDepsOptimizer
      )(this)
    }
  }

  fetchModule(id: string, importer?: string): Promise<FetchResult> {
    return fetchModule(this, id, importer, this._ssrRunnerOptions)
  }

  transformRequest(url: string): Promise<TransformResult | null> {
    return transformRequest(url, this.server, undefined, this)
  }

  async warmupRequest(url: string): Promise<void> {
    await transformRequest(url, this.server, undefined, this).catch((e) => {
      if (
        e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
        e?.code === ERR_CLOSED_SERVER
      ) {
        // these are expected errors
        return
      }
      // Unexpected error, log the issue but avoid an unhandled exception
      this.server.config.logger.error(`Pre-transform error: ${e.message}`, {
        error: e,
        timestamp: true,
      })
    })
  }

  async close(): Promise<void> {
    await this.depsOptimizer?.close()
  }
}

function invalidateModule(
  environment: DevEnvironment,
  m: {
    path: string
    message?: string
  },
) {
  const mod = environment.moduleGraph.urlToModuleMap.get(m.path)
  if (
    mod &&
    mod.isSelfAccepting &&
    mod.lastHMRTimestamp > 0 &&
    !mod.lastHMRInvalidationReceived
  ) {
    mod.lastHMRInvalidationReceived = true
    environment.logger.info(
      colors.yellow(`hmr invalidate `) +
        colors.dim(m.path) +
        (m.message ? ` ${m.message}` : ''),
      { timestamp: true },
    )
    const file = getShortName(mod.file!, environment.config.root)
    updateModules(
      environment,
      file,
      [...mod.importers],
      mod.lastHMRTimestamp,
      environment.server,
      true,
    )
  }
}
