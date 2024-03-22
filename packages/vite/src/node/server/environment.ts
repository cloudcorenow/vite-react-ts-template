import type { FetchResult } from 'vite/module-runner'
import { Environment } from '../environment'
import type { ViteDevServer } from '../server'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import type { DevEnvironmentConfig } from '../config'
import { getDefaultResolvedDevEnvironmentConfig } from '../config'
import { mergeConfig } from '../utils'
import type { FetchModuleOptions } from '../ssr/fetchModule'
import { fetchModule } from '../ssr/fetchModule'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { HMRChannel } from './hmr'
import { createNoopHMRChannel } from './hmr'
import { transformRequest } from './transformRequest'
import type { TransformResult } from './transformRequest'
import { ERR_CLOSED_SERVER } from './pluginContainer'
import type { RemoteEnvironmentTransport } from './environmentTransport'

// Maybe we will rename this to DevEnvironment
export class DevEnvironment extends Environment {
  mode = 'dev' as const // TODO: should this be 'serve'?
  moduleGraph: EnvironmentModuleGraph
  server: ViteDevServer
  config: DevEnvironmentConfig
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
    options?: {
      hot?: false | HMRChannel
      config?: DevEnvironmentConfig
      runner?: FetchModuleOptions & {
        transport?: RemoteEnvironmentTransport
      }
    },
  ) {
    super(name)
    this.server = server
    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) =>
      this.server.pluginContainer.resolveId(url, undefined, {
        environment: this,
      }),
    )
    this.hot = options?.hot || createNoopHMRChannel()

    this.config =
      server.config.environments[name] ??
      getDefaultResolvedDevEnvironmentConfig(server.config)
    if (options?.config) {
      this.config = mergeConfig(this.config, options?.config)
    }

    const ssrRunnerOptions = options?.runner || {}
    this._ssrRunnerOptions = ssrRunnerOptions
    options?.runner?.transport?.initialize(this)
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
}
