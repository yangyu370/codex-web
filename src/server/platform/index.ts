import { createMacPlatform } from "./macos";
import { type HostPlatform, PlatformError, type PlatformRuntime } from "./types";
import { createWindowsPlatform } from "./windows";

export { createMacPlatform, createWindowsPlatform };
export type {
  AppServerProcess,
  HostPlatform,
  PlatformRuntime,
  ValidatedPath,
} from "./types";
export { PlatformError } from "./types";

export function selectHostPlatform(
  platform: NodeJS.Platform,
  runtime: PlatformRuntime,
): HostPlatform {
  if (platform === "darwin") {
    return createMacPlatform(runtime);
  }
  if (platform === "win32") {
    return createWindowsPlatform(runtime);
  }
  throw new PlatformError("unsupportedPlatform", platform);
}
