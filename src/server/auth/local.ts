import type { LocalAuthConfig } from "./config";

export function authorizeLocalRequest(
  request: Request,
  config: LocalAuthConfig,
): void {
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  if (!config.origins.includes(origin)) {
    throw new Error("notAuthenticated: origin is not allowed");
  }
}

