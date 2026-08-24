import path from "node:path";

import type { HostPlatform } from "../platform";
import type { JsonRpcTransport } from "./json-rpc";
import type {
  SharedAppServerBackend,
  SharedBackendContext,
  WindowsSharedPolicy,
} from "./shared-backend";
import { connectTcpWebSocket, parseManagedLoopbackEndpoint } from "./tcp-websocket-transport";
import { createWindowsCoordinatorRuntime } from "./windows-coordinator-runtime";
import {
  WindowsSharedAppServerCoordinator,
  type WindowsSharedAppServerCoordinatorOptions,
  type WindowsSharedConnectionInfo,
} from "./windows-shared-coordinator";
import { codexVersionAtLeast, MINIMUM_WINDOWS_SHARED_VERSION } from "./windows-version";

export interface WindowsManagedBackendOptions {
  env: Record<string, string>;
  coordinatorFactory?: (
    options: WindowsSharedAppServerCoordinatorOptions,
  ) => Pick<WindowsSharedAppServerCoordinator, "ensure">;
  connect?: (endpoint: string) => Promise<JsonRpcTransport>;
}

export function parseWindowsSharedPolicy(value: string | undefined): WindowsSharedPolicy {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "required" || value === "off") return value;
  throw new Error("CODEX_WEB_WINDOWS_SHARED must be auto, required, or off");
}

export class WindowsManagedBackend implements SharedAppServerBackend {
  readonly kind = "managedTcp" as const;
  readonly #platform: HostPlatform;
  readonly #options: WindowsManagedBackendOptions;

  constructor(platform: HostPlatform, options: WindowsManagedBackendOptions) {
    this.#platform = platform;
    this.#options = options;
  }

  async ensureAndConnect(context: SharedBackendContext) {
    if (!codexVersionAtLeast(context.cliVersion, MINIMUM_WINDOWS_SHARED_VERSION)) {
      throw new Error(
        `Windows shared app-server requires Codex ${MINIMUM_WINDOWS_SHARED_VERSION} or newer`,
      );
    }
    const env = { ...this.#options.env, ...context.env };
    const endpoint = normalizedEndpoint(
      env.CODEX_WEB_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
    );
    const codexHome = path.win32.resolve(
      env.CODEX_HOME ?? path.win32.join(this.#platform.homeDirectory(), ".codex"),
    );
    const coordinatorOptions: WindowsSharedAppServerCoordinatorOptions = {
      endpoint,
      codexHome,
      executable: context.executable,
      cliVersion: context.cliVersion,
      runtime: createWindowsCoordinatorRuntime({
        dataDirectory: this.#platform.dataDirectory(),
        codexHome,
        cliVersion: context.cliVersion,
        bunExecutable: process.execPath,
        lifecycleScript: path.resolve(import.meta.dir, "../../../scripts/app-server-lifecycle.ts"),
        env,
      }),
    };
    const coordinator = this.#options.coordinatorFactory?.(coordinatorOptions)
      ?? new WindowsSharedAppServerCoordinator(coordinatorOptions);
    const info: WindowsSharedConnectionInfo = await coordinator.ensure();
    if (!codexVersionAtLeast(info.appServerVersion, MINIMUM_WINDOWS_SHARED_VERSION)) {
      throw new Error(
        `Windows shared app-server requires Codex ${MINIMUM_WINDOWS_SHARED_VERSION} or newer`,
      );
    }
    const transport = await (this.#options.connect ?? connectTcpWebSocket)(info.endpoint);
    return {
      info: {
        backend: this.kind,
        endpoint: { kind: "tcp" as const, url: info.endpoint },
        cliVersion: info.cliVersion,
        appServerVersion: info.appServerVersion,
        ...(info.restartRequired ? { restartRequired: true } : {}),
      },
      transport,
    };
  }
}

function normalizedEndpoint(source: string): string {
  return parseManagedLoopbackEndpoint(source).href.replace(/\/$/, "");
}
