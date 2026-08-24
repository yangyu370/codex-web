import path from "node:path";

import type { HostPlatform } from "../platform";
import { startManagedDaemon, type DaemonConnectionInfo } from "./daemon";
import type { JsonRpcTransport } from "./json-rpc";
import type {
  SharedAppServerBackend,
  SharedBackendContext,
} from "./shared-backend";
import { connectUnixWebSocket } from "./unix-websocket-transport";

export interface MacNativeDaemonBackendOptions {
  daemonStart?: (
    executable: string,
    codexHome: string,
  ) => Promise<DaemonConnectionInfo>;
  daemonConnect?: (socketPath: string) => Promise<JsonRpcTransport>;
}

export class MacNativeDaemonBackend implements SharedAppServerBackend {
  readonly kind = "nativeDaemon" as const;
  readonly #platform: HostPlatform;
  readonly #options: MacNativeDaemonBackendOptions;

  constructor(platform: HostPlatform, options: MacNativeDaemonBackendOptions = {}) {
    this.#platform = platform;
    this.#options = options;
  }

  async ensureAndConnect(context: SharedBackendContext) {
    const codexHome = context.env.CODEX_HOME
      ?? path.posix.join(this.#platform.homeDirectory(), ".codex");
    const startDaemon = this.#options.daemonStart
      ?? ((executable: string, activeCodexHome: string) => startManagedDaemon(
        executable,
        activeCodexHome,
        {
          spawn: (command, environment) => this.#platform.spawnCommand(
            command,
            { ...environment, ...context.env, CODEX_HOME: activeCodexHome },
          ),
        },
      ));
    const daemon = await startDaemon(context.executable, codexHome);
    const transport = await (this.#options.daemonConnect ?? connectUnixWebSocket)(
      daemon.socketPath,
    );
    return {
      info: {
        backend: this.kind,
        endpoint: { kind: "unix" as const, path: daemon.socketPath },
        cliVersion: context.cliVersion,
        ...(daemon.appServerVersion
          ? { appServerVersion: daemon.appServerVersion }
          : {}),
      },
      transport,
    };
  }
}
