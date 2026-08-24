import type { HostPlatform } from "../platform";
import type { DaemonConnectionInfo } from "./daemon";
import type { JsonRpcTransport } from "./json-rpc";
import { MacNativeDaemonBackend } from "./macos-daemon-backend";

export type SharedBackendKind = "nativeDaemon" | "managedTcp";
export type WindowsSharedPolicy = "auto" | "required" | "off";

export type SharedServerEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; url: string };

export interface SharedServerInfo {
  backend: SharedBackendKind;
  endpoint: SharedServerEndpoint;
  cliVersion: string;
  appServerVersion?: string;
  restartRequired?: boolean;
}

export interface SharedBackendContext {
  executable: string;
  cliVersion: string;
  env: Record<string, string>;
}

export interface SharedAppServerBackend {
  readonly kind: SharedBackendKind;
  ensureAndConnect(context: SharedBackendContext): Promise<{
    info: SharedServerInfo;
    transport: JsonRpcTransport;
  }>;
}

export interface SharedBackendSelectionOptions {
  env: Record<string, string>;
  windowsPolicy?: WindowsSharedPolicy;
  windowsBackend?: SharedAppServerBackend;
  daemonStart?: (
    executable: string,
    codexHome: string,
  ) => Promise<DaemonConnectionInfo>;
  daemonConnect?: (socketPath: string) => Promise<JsonRpcTransport>;
}

export function selectSharedAppServerBackend(
  platform: HostPlatform,
  options: SharedBackendSelectionOptions,
): SharedAppServerBackend | undefined {
  if (platform.kind === "macos") {
    return new MacNativeDaemonBackend(platform, {
      daemonStart: options.daemonStart,
      daemonConnect: options.daemonConnect,
    });
  }
  if (options.windowsPolicy === "off") return undefined;
  return options.windowsBackend;
}
