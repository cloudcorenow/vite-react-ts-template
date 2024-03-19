# Vite Environment API

:::warning Low-level API
Initial work for this API was introduced in Vite 5.1 with the name "Vite Runtime API". In Vite 5.2 the API was reviewed and renamed as Vite Environment API. It remains an experimental feature. We are gathering feedback about the revised proposal [here](https://github.com/vitejs/vite/discussions/15774). There will probably be breaking changes to it in Vite 5.3, so make sure to pin the Vite version to `~5.2.0` when using it. This is a low-level API meant for library and framework authors. If your goal is to create an application, make sure to check out the higher-level SSR plugins and tools at [Awesome Vite SSR section](https://github.com/vitejs/awesome-vite#ssr) first.
:::

A single Vite dev server can be used to interact with different module execution environments concurrently. We'll use the word environment to refer to a configured Vite processing pipeline that can resolve ids, load, and process source code and is connected to a runtime where the code is executed. The transformed source code is called a module, and the relationships between the modules processed in each environment are kept in a module graph. The code for these modules is sent to the runtimes associated with each environment to be executed. When a module is evaluated, the runtime will request its imported modules triggering the processing of a section of the module graph. In a typical Vite app, an environments will be used for the ES modules served to the client and for the server program that does SSR. An app can do SSR on a Node server, but also on an edge runtime like Workerd. So we can have different types of environments on the same Vite server: browser environments, node environments, and workerd environments to name a few.

A Vite Module Runner allows running any code by processing it with Vite plugins first. It is different from `server.ssrLoadModule` because the runner implementation is decoupled from the server. This allows library and framework authors to implement their layer of communication between the Vite server and the runner. The browser communicates with its corresponding environment using the server Web Socket and through HTTP requests. The Node Module runner can directly do function calls to process modules as it is running in the same process. Other environments could run modules connecting to an edge runtime like workerd, or a Worker Thread as Vitest does.

All these environments share Vite's HTTP server, middlewares, and Web Socket. The resolved config and plugins pipeline are also shared, but plugins can use `apply` so its hooks are only called for certain environments. The environment can also be accessed inside hooks for fine-grained control.

![Vite Environments](../images/vite-environments.svg)

## Using environments in the Vite server

A Vite dev server exposes two environments by default: `server.clientEnvironment` and `server.ssrEnvironment`. The client environment is a browser environment by default, and the module runner is implemented by importing the virtual module `/@vite/client` to client apps. The SSR environment runs in the same Node runtime as the Vite server by default and allows application servers to be used to render requests during dev with full HMR support. We'll discuss later how frameworks and users can change the environment types for the default client and SSR environments, or register new environments (for example to have a separate module graph for RSC).

The available environments can be accessed using the `server.environments` array:

```js
server.environments.forEach((environment) => log(environment.name))
```

An dev environment is an instance of the `DevEnvironment` class:

```ts
class DevEnvironment {
  /**
   * Unique identifier for the environment in a Vite server.
   * By default Vite exposes 'browser' and 'node' environments.
   */
  name: string
  /**
   * Communication channel to send and receive messages from the
   * associated module runner in the target runtime.
   */
  hot: HMRChannel | null
  /**
   * Graph of module nodes, with the imported relationship between
   * processed modules and the cached result of the processed code.
   */
  moduleGraph: ModuleGraph
  /**
   * TBD: This abstraction isn't yet clear
   * Trigger the execution of a module using the associated module runner
   * in the target runtime.
   */
  run: ModuleRunFunction
  /**
   * Resolved config options for this environment. Options at the server
   * global scope are taken as defaults for all environments, and can
   * be overridden (resolve conditions, external, optimizedDeps)
   */
  config: ResolvedEnvironmentConfig

  constructor(server, { name, hot, run, config }: DevEnvironmentOptions)

  /**
   * Resolve the URL to an id, load it, and process the code using the
   * plugins pipeline. The module graph is also updated.
   */
  async transformRequest(url: string): TransformResult

  /**
   * Register a request to be processed with low priority. This is useful
   * to avoid waterfalls. The Vite server has information about the imported
   * modules by other requests, so it can warmup the module graph so the
   * modules are already processed when they are requested.
   */
  async warmupRequest(url: string): void

  /**
   * Fetch information about a module from the module runner without running it.
   * Note: This method may not be needed
   */
  async fetchModuleInfo(url: string)
}
```

With `TransformResult` being:

```ts
interface TransformResult {
  code: string
  map: SourceMap | { mappings: '' } | null
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}
```

An environment instance in the Vite server lets you process a URL using the `environment.transformRequest(url)` method. This function will use the plugin pipeline to resolve the `url` to a module `id`, load it (reading the file from the file system or through a plugin that implements a virtual module), and then transform the code. While transforming the module, imports and other metadata will be recorded in the environment module graph by creating or updating the corresponding module node. When processing is done, the transform result is also stored in the module.

But the environment instance can't execute the code itself, as the runtime where the module will be run could be different from the one the Vite server is running in. This is the case for the browser environment. When a html is loaded in the browser, its scripts are executed triggering the evaluation of the entire static module graph. Each imported URL generates a request to the Vite server to get the module code, which ends up handled by the Transform Middleware by calling `server.clientEnvironment.transformRequest(url)`. The connection between the environment instance in the server and the module runner in the browser is carried out through HTTP in this case.

:::info transformRequest naming
We are using `transformRequest(url)` and `warmupRequest(url)` in the current version of this proposal so it is easier to discuss and understand for users used to Vite's current API. Before releasing, we can take the opportunity to review these names too. For example, it could be named `environment.processModule(url)` or `environment.loadModule(url)` taking a page from Rollup's `context.load(id)` in plugin hooks. For the moment, we think keeping the current names and delaying this discussion is better.
:::

For the default Node environment, Vite creates a module runner that implements evaluation using `new AsyncFunction` running in the same runtime as the server. This runner is an instance of `ModuleRunner` that exposes:

```ts
class ModuleRunner {
  /**
   * URL to execute. Accepts file path, server path, or id relative to the root.
   * Returns an instantiated module (same as in ssrLoadModule)
   */
  public async import(url: string): Promise<Record<string, any>>
  /**
   * Other ModuleRunner methods...
   */
```

:::info
In the previous iteration, we had `executeUrl` and `executeEntryPoint` methods - they are now merged into a single `import` method. If you want to opt-out of the HMR support, create a runner with `hmr: false` flag.
:::

The default SSR Node module runner instance is accessible through `server.ssrModuleRunner`. It isn't part of its associated environment instance because, as we explained before, other environments' module runners could live in a different runtime (for example for the browser, a module runner in a worker thread as used in Vitest, or an edge runtime like workerd). The communication between `server.ssrModuleRunner` and `server.ssrEnvironment` is implemented through direct function calls. Given a Vite server configured in middleware mode as described by the [SSR setup guide](#setting-up-the-dev-server), let's implement the SSR middleware using the environment API. Error handling is omitted.

```js
app.use('*', async (req, res, next) => {
  const url = req.originalUrl

  // 1. Read index.html
  let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8')

  // 2. Apply Vite HTML transforms. This injects the Vite HMR client,
  //    and also applies HTML transforms from Vite plugins, e.g. global
  //    preambles from @vitejs/plugin-react
  template = await server.transformIndexHtml(url, template)

  // 3. Load the server entry. import(url) automatically transforms
  //    ESM source code to be usable in Node.js! There is no bundling
  //    required, and provides full HMR support.
  const { render } = await server.ssrModuleRunner.import('/src/entry-server.js')

  // 4. render the app HTML. This assumes entry-server.js's exported
  //     `render` function calls appropriate framework SSR APIs,
  //    e.g. ReactDOMServer.renderToString()
  const appHtml = await render(url)

  // 5. Inject the app-rendered HTML into the template.
  const html = template.replace(`<!--ssr-outlet-->`, appHtml)

  // 6. Send the rendered HTML back.
  res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
})
```

## Environment agnostic SSR

One of the objectives of this proposal is to allow users to swap Vite's default SSR environment. Out-of-the-box, Vite will use a node environment running on the same process as the server. But a user may want to swap it for a workerd environment.

Vite could expose a `server.ssrEnvironment` so all frameworks can use it and allow them to define what environment type should be used for it. Ideally, instead of using `server.ssrModuleRunner`, the example above would be written as:

```js
// 3. Load the server entry, with full HMR support.
//    Only functions that accepts serializable params and results are supported.
const { render } = await server.ssrEnvironment.import('/src/entry-server.js')

// 4. render the app HTML.
const appHtml = await render(url)
```

`import(url)` would return RPC wrappers for `entry-server` exported functions, so that this code is compatible with both node and workerd environments.

A `environment.import(url): RPC exports` may be difficult to implement across all environments. So it isn't part of the initial proposal. Given that a lot of projects in the ecosystem end up re-implementating a RPC scheme, we could add it later as a feature that can be supported by a subset of all environments and promote its use only for use cases that don't target universal runtime support. For example, for tools using Vite that are intended to run in a node like environment and want to use a worker thread environment like Vitest.

In this proposal, environments expose a `environment.run(url): void` function to request running the url in the associated module runner.

## Plugins and environments

The Vite server has a shared plugin pipeline, but when a module is processed it is always done in the context of a given environment.

### The `hotUpdate` hook

- **Type:** `(ctx: HotContext) => Array<ModuleNode> | void | Promise<Array<ModuleNode> | void>`
- **See also:** [HMR API](./api-hmr)

The `hotUpdate` hook allows plugins to perform custom HMR update handling for a given environment. When a file changes, the HMR algorithm is run for each environment in series according to the order in `server.environments`, so the `hotUpdate` hook will be called multiple times. The hook receives a context object with the following signature:

```ts
interface HotContext {
  file: string
  timestamp: number
  environment: string
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}
```

- `environment` is the module execution environment where a file update is currently being processed.

- `modules` is an array of modules in this environment that are affected by the changed file. It's an array because a single file may map to multiple served modules (e.g. Vue SFCs).

- `read` is an async read function that returns the content of the file. This is provided because, on some systems, the file change callback may fire too fast before the editor finishes updating the file, and direct `fs.readFile` will return empty content. The read function passed in normalizes this behavior.

The hook can choose to:

- Filter and narrow down the affected module list so that the HMR is more accurate.

- Return an empty array and perform a full reload:

  ```js
  hotUpdate({ environment, modules, timestamp }) {
    if (environment !== 'browser')
      return

    const serverEnvironment = server.environment(environment)

    serverEnvironment.hot.send({ type: 'full-reload' })
    // Invalidate modules manually
    const invalidatedModules = new Set()
    for (const mod of modules) {
      serverEnvironment.moduleGraph.invalidateModule(
        mod,
        invalidatedModules,
        timestamp,
        true
      )
    }
    return []
  }
  ```

- Return an empty array and perform complete custom HMR handling by sending custom events to the client:

  ```js
  hotUpdate({ environment }) {
    if (environment !== 'browser')
      return

    server.environment(environment).hot.send({
      type: 'custom',
      event: 'special-update',
      data: {}
    })
    return []
  }
  ```

  Client code should register the corresponding handler using the [HMR API](./api-hmr) (this could be injected by the same plugin's `transform` hook):

  ```js
  if (import.meta.hot) {
    import.meta.hot.on('special-update', (data) => {
      // perform custom update
    })
  }
  ```

### Using `apply`

In the examples of the previous section, we used a guard in the `hotUpdate` hook to only process updates from the browser environment. If a plugin is specific to only some of the available environments, `apply` can be used to avoid guarding each hook and improve performance.

```js
function nodeOnlyPlugin() {
  return {
    name: 'node-only-plugin',
    apply: ({ environment }) => environment === 'node',
    // unguarded hooks...
  }
}
```

### Accessing the current environment in hooks

The `environment` name is passed as a parameter to the `options` of `resolveId`, `load`, and `transform`.

A plugin could use the `environment` instance to:

- Only apply logic for certain environments.
- Change the way they work depending on the configuration for the environment, which can be accessed using `environment.config`. The vite core resolve plugin modifies the way it resolves ids based on `environment.config.resolve.conditions` for example.

## Separate module graphs

Vite currently has a mixed Client and SSR module graph. Given an unprocessed or invalidated node, it isn't possible to know if it corresponds to the Client, SSR, or both environments. Module nodes have some properties prefixed, like `clientImportedModules` and `ssrImportedModules` (and `importedModules` that returns the union of both). `importers` contains all importers from both the Client and SSR environment for each module node. A module node also has `transformResult` and `ssrTransformResult`.

In this proposal, each environment has its module graph (and a backward compatibility layer will be implemented to give time to the ecosystem to migrate). All module graphs have the same signature, so generic algorithms can be implemented to crawl or query the graph without depending on the environment. `hotUpdate` is a good example. When a file is modified, the module graph of each environment will be used to discover the affected modules and perform HMR for each environment independently.

Each module is represented by a `ModuleNode` instance. Modules may be registered in the graph without yet being processed (`transformResult` would be `null` in that case). `importers` and `importedModules` are also updated after the module is processed.

```ts
class ModuleNode {
  environment: string

  url: string
  id: string | null = null
  file: string | null = null

  type: 'js' | 'css'

  importers = new Set<ModuleNode>()
  importedModules = new Set<ModuleNode>()
  importedBindings: Map<string, Set<string>> | null = null

  info?: ModuleInfo
  meta?: Record<string, any>
  transformResult: TransformResult | null = null

  acceptedHmrDeps = new Set<ModuleNode>()
  acceptedHmrExports: Set<string> | null = null
  isSelfAccepting?: boolean
  lastHMRTimestamp = 0
  lastInvalidationTimestamp = 0
}
```

`environment.moduleGraph` is an instance of `ModuleGraph`:

```ts
export class ModuleGraph {
  environment: string

  urlToModuleMap = new Map<string, ModuleNode>()
  idToModuleMap = new Map<string, ModuleNode>()
  etagToModuleMap = new Map<string, ModuleNode>()
  fileToModulesMap = new Map<string, Set<ModuleNode>>()

  constructor(
    environment: string,
    resolveId: (url: string) => Promise<PartialResolvedId | null>,
  )

  async getModuleByUrl(rawUrl: string): Promise<ModuleNode | undefined>

  getModulesByFile(file: string): Set<ModuleNode> | undefined

  onFileChange(file: string): void

  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
    isHmr: boolean = false,
  ): void

  invalidateAll(): void

  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,
  ): Promise<Set<ModuleNode> | undefined>

  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
  ): Promise<ModuleNode>

  createFileOnlyEntry(file: string): ModuleNode

  async resolveUrl(url: string): Promise<ResolvedUrl>

  updateModuleTransformResult(
    mod: ModuleNode,
    result: TransformResult | null,
  ): void

  getModuleByEtag(etag: string): ModuleNode | undefined
}
```

## Creating new environments

One of the goals of this feature is to provide a customizable API to process and run code. Users can create new environment types using the exposed primitives.

```ts
import { DevEnvironment } from 'vite'

function createWorkerdDevEnvironment(server: ViteDevServer, name: string, config?: DevEnvironmentConfig) {
  const workerdModuleRunner = /* ... */
  const hot = /* ... */

  const workerdDevEnvironment = new DevEnvironment(server, name, {
    config: {
      resolve: { conditions: ['custom'] },
      ...config,
    },
    hot,
  })
  return workerdDevEnvironment
}
```

Then users can create a workerd environment to do SSR using:

```js
const ssrEnvironment = createWorkerdEnvironment(server, 'ssr')
```

## Environment Configuration

Environments are explicitely configured with the `environments` config option.

```js
export default {
  environments: [
    {
      name: 'client',
      resolve: {
        conditions: [], // configure for the default Client environment
      },
    },
    {
      name: 'ssr',
      optimizeDeps: {}, // configure for the default SSR environment
    },
    {
      name: 'rsc',
      noExternal: true, // configure for a different environment
    },
  ],
}
```

But Vite's user config extends from a environment config, letting users configure the Client environment directly with top level properties as a shortcut. This catters to the common use case of configuring a Vite client only app.
The SSR environment can also be configured using the `ssr` top level property. In a typical SSR Vite app, the user config will look like:

```js
export default {
  resolve: {
    conditions: [], // configure the default Client environment (shortcut)
  },
  ssr: {
    resolve: {
      conditions: [], // configure the default SSR environment (shortcut)
    },
  },
}
```

The `EnvironmentConfig` interface exposes all the per-environment options. There are `SharedEnvironmentConfig` that apply to both `build` and `dev` environments, like `resolve`. And there are `DevOptions` and `BuildOptions`

```ts
interface EnvironmentConfig extends SharedEnvironmentConfig {
  dev: DevOptions
  build: BuildOptions
}
```

As we explained, the `UserConfig` interface extends from `EnvironmentConfig`. Environment specific options defined at the root level of user config are used for the default client environment. The `ssr` property is also of type `EnvironmentConfig`. And environments can be configured explicitely using the `environments` array. The Client and SSR environments, are always present, even if an empty array is set to `environments`.

```ts
interface UserConfig extends EnvironmentConfig {
  ssr: EnvironmentConfig
  environments: (EnvironmentConfig & { name: string })[]
  // other options
}
```

## Registering environments

To register a new dev or build environment, you can use a `create` function:

```js
export default {
  environments: [
    {
      name: 'rsc',
      dev: {
        create: (server) => createNodeDevEnvironment(server),
      },
      build: {
        create: (builder) => createNodeBuildEnvironment(builder),
        outDir: '/dist/rsc',
      },
    },
  ],
}
```

Environment providers like Workerd, can expose an environment configurator for the most common case of using the same runtime for both dev and build environments. The default environment options can also be set so the user doesn't need to do it.

```js
function createWorkedEnvironment(userConfig) {
  return mergeConfig(
    {
      resolve: {
        conditions: [
          /*...*/
        ],
      },
      dev: {
        createEnvironment: (server, name) =>
          createWorkerdDevEnvironment(server, name),
      },
      build: {
        createEnvironment: (builder, name) =>
          createWorkerdBuildEnvironment(builder, name),
      },
    },
    userConfig,
  )
}
```

Then the config file can be writen as

```js
import { workerdEnvironment } from 'vite-environment-workerd'

export default {
  environments: [
    createWorkerdEnvironment({
      name: 'rsc',
      build: {
        outDir: '/dist/rsc',
      },
    }),
  ],
}
```

The environment will be accessible in middlewares or plugin hooks through `server.environments`. In plugin hooks, the environment instance is passed in the options so they can do conditions depending on the way they are configured.

## `ModuleRunner`

A module runner is instantiated in the target runtime. All APIs in the next section are imported from `vite/module-runner` unless stated otherwise. This export entry point is kept as lightweight as possible, only exporting the minimal needed to create runners in the

**Type Signature:**

```ts
export class ModuleRunner {
  constructor(
    public options: ModuleRunnerOptions,
    public evaluator: ModuleEvaluator,
    private debug?: ModuleRunnerDebugger,
  ) {}
  /**
   * URL to execute. Accepts file path, server path, or id relative to the root.
   */
  public async import<T = any>(url: string): Promise<T>
  /**
   * Clear all caches including HMR listeners.
   */
  public clearCache(): void
  /**
   * Clears all caches, removes all HMR listeners, and resets source map support.
   * This method doesn't stop the HMR connection.
   */
  public async destroy(): Promise<void>
  /**
   * Returns `true` if the runner has been destroyed by calling `destroy()` method.
   */
  public isDestroyed(): boolean
}
```

The module evaluator in `ModuleRunner` is responsible for executing the code. Vite exports `ESModulesEvaluator` out of the box, it uses `new AsyncFunction` to evaluate the code. You can provide your own implementation if your JavaScript runtime doesn't support unsafe evaluation.

Module runner exposes `import` method. When Vite server triggers `full-reload` HMR event, all affected modules will be re-executed. Be aware that Module Runner doesn't update `exports` object when this happens (it overrides it), you would need to run `import` or get the module from `moduleCache` again if you rely on having the latest `exports` object.

**Example Usage:**

```js
import { ModuleRunner, ESModulesEvaluator } from 'vite/module-runner'
import { root, fetchModule } from './rpc-implementation.js'

const moduleRunner = new ModuleRunner(
  {
    root,
    fetchModule,
    // you can also provide hmr.connection to support HMR
  },
  new ESModulesEvaluator(),
)

await moduleRunner.import('/src/entry-point.js')
```

## `ModuleRunnerOptions`

```ts
export interface ModuleRunnerOptions {
  /**
   * Root of the project
   */
  root: string
  /**
   * A method to get the information about the module.
   */
  fetchModule: FetchFunction
  /**
   * Configure how source maps are resolved. Prefers `node` if `process.setSourceMapsEnabled` is available.
   * Otherwise it will use `prepareStackTrace` by default which overrides `Error.prepareStackTrace` method.
   * You can provide an object to configure how file contents and source maps are resolved for files that were not processed by Vite.
   */
  sourcemapInterceptor?:
    | false
    | 'node'
    | 'prepareStackTrace'
    | InterceptorOptions
  /**
   * Disable HMR or configure HMR options.
   */
  hmr?:
    | false
    | {
        /**
         * Configure how HMR communicates between the client and the server.
         */
        connection: ModuleRunnerHMRConnection
        /**
         * Configure HMR logger.
         */
        logger?: false | HMRLogger
      }
  /**
   * Custom module cache. If not provided, it creates a separate module cache for each module runner instance.
   */
  moduleCache?: ModuleCacheMap
}
```

## `ModuleEvaluator`

**Type Signature:**

```ts
export interface ModuleEvaluator {
  /**
   * Evaluate code that was transformed by Vite.
   * @param context Function context
   * @param code Transformed code
   * @param id ID that was used to fetch the module
   */
  runInlinedModule(
    context: ModuleRunnerContext,
    code: string,
    id: string,
  ): Promise<any>
  /**
   * evaluate externalized module.
   * @param file File URL to the external module
   */
  runExternalModule(file: string): Promise<any>
}
```

Vite exports `ESModulesEvaluator` that implements this interface by default. It uses `new AsyncFunction` to evaluate code, so if the code has inlined source map it should contain an [offset of 2 lines](https://tc39.es/ecma262/#sec-createdynamicfunction) to accommodate for new lines added. This is done automatically in the server node environment. If your runner implementation doesn't have this constraint, you should use `fetchModule` (exported from `vite`) directly.

## ModuleRunnerHMRConnection

**Type Signature:**

```ts
export interface ModuleRunnerHMRConnection {
  /**
   * Checked before sending messages to the client.
   */
  isReady(): boolean
  /**
   * Send a message to the client.
   */
  send(message: string): void
  /**
   * Configure how HMR is handled when this connection triggers an update.
   * This method expects that the connection will start listening for HMR updates and call this callback when it's received.
   */
  onUpdate(callback: (payload: HMRPayload) => void): void
}
```

This interface defines how HMR communication is established. Vite exports `ServerHMRConnector` from the main entry point to support HMR during Vite SSR. The `isReady` and `send` methods are usually called when the custom event is triggered (like, `import.meta.hot.send("my-event")`).

`onUpdate` is called only once when the new module runner is initiated. It passed down a method that should be called when connection triggers the HMR event. The implementation depends on the type of connection (as an example, it can be `WebSocket`/`EventEmitter`/`MessageChannel`), but it usually looks something like this:

```js
function onUpdate(callback) {
  this.connection.on('hmr', (event) => callback(event.data))
}
```

The callback is queued and it will wait for the current update to be resolved before processing the next update. Unlike the browser implementation, HMR updates in a module runner will wait until all listeners (like, `vite:beforeUpdate`/`vite:beforeFullReload`) are finished before updating the modules.

## Environments during build

Plugin hooks also receive the environment instance during build. This replaces the `ssr` boolean we have been passing them so far.

In the CLI, calling `vite build` will build the Client. It is equivalent to calling `vite build --environment=client`.

The build the SSR server, the `--ssr` shourcut can be used: `vite build --ssr`. This is equivalent to calling `vite build --environment=ssr`.

Other non-default environments can be build using `vite build --environment=name`.

## Building all environments

Calling `vite build --all` will instantiate a `ViteBuilder` (build-time equivalent to a `ViteDevServer`) to build all configured environments for production. By default the build of environments is run in series respecting the order of the `environments` array. A framework or user can further configure how the build tasks are excecuted using:

```js
export default {
  builder: {
    runBuildTasks: asnyc (builder, buildTasks) => {
      return Promise.all(buildTasks.map( task => task.run() ))
    }
  }
}
```

A build task implements the `BuildTask` interface:

```js
export interface BuildTask {
  environment: BuildEnvironment
  config: ResolvedConfig
  run: () => Promise<void>
  cancel: () => void
}
```

## Backward Compatibility

The current Vite server API will be deprecated but keep working during the next major.

|                    Before                     |                      After                       |
| :-------------------------------------------: | :----------------------------------------------: |
|        `server.transformRequest(url)`         | `server.clientEnvironment.transformRequest(url)` |
| `server.transformRequest(url, { ssr: true })` |   `server.ssrEnvironment.tranformRequest(url)`   |
|          `server.warmupRequest(url)`          |  `server.clientEnvironment.warmupRequest(url)`   |
|          `server.ssrLoadModule(url)`          |                      `TBD`                       |
|             `server.moduleGraph`              |            `environment.moduleGraph`             |
|               `handleHotUpdate`               |                   `hotUpdate`                    |

The last one is just an idea. We may want to keep `server.open(url)` around.

The `server.moduleGraph` will keep returning a mixed view of the client and ssr module graphs. Backward compatible mixed module nodes will be returned from all previous functions. The same scheme is used for the module nodes passed to `handleHotUpdate`. This is the most difficult change to get right regarding backward compatibility. We may need to accept small breaking changes when we release the API in Vite 6, making it opt-in until then when releasing the API as experimental in Vite 5.2.

## Open Questions and Alternatives

There are some open questions and alternatives as info boxes interlined in the guide.

Names for concepts and the API are the best we could currently find, which we should keep discussing before releasing if we end up adopting this proposal. Here are some of the alternative names we discussed in the process of creating this proposal.

### ModuleLoader vs Environment

Instead of `DevEnvironment`, we thought of calling the environment piece inside the Vite Server a `ModuleLoader`. So `server.clientEnvironment` would be `server.clientModuleLoader`. It has some advantages, `transformRequest(url)` could be renamed to `moduleLoader.load(url)`. We could pass to hooks a `loader` string instead of an `environment` string. `vite build --loader=node` could also be ok, but it is already a stretch. A `ModuleLoader` having a `run()` function that connects it to the `ModuleRunner` in the associated runtime also didn't seem like a good fit though. And `loader` could be confused with a node loader, or with the module loader in the target runtime.

### Runtime vs Environment

We also discussed naming runtime to the concept we call environment in this proposal. We decided to go with Environment because a Runtime refers to node, bun, deno, workerd, a browser. But we need to be able to define two different module execution "environments" for the same runtime. For example SSR and RSC environments, both running in the same node runtime.
