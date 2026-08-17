import type { AuthConfig, RemoteAuthConfig } from "../auth/config";
import { verifyCloudflareToken } from "../auth/cloudflare";
import { authorizeLocalRequest } from "../auth/local";
import { encodeServerMessage } from "../../shared/protocol";
import type { BrowserGateway } from "./gateway";
import type { WebState } from "./state";
import type { UserSettings } from "./settings";
import path from "node:path";

export interface WebRequestHandlerDependencies {
  auth: AuthConfig;
  state: WebState;
  verifyRemote?: (token: string, config: RemoteAuthConfig) => Promise<unknown>;
  staticRoot?: string;
  settings?: {
    read(): Promise<UserSettings>;
    save(value: UserSettings): Promise<void>;
  };
}

export function createWebRequestHandler(
  dependencies: WebRequestHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/healthz") {
      return json({ status: "live" });
    }

    try {
      await authorizeWebRequest(request, dependencies);
    } catch (error) {
      const message = error instanceof Error ? error.message : "notAuthenticated";
      const forbidden = message.includes("origin");
      return json(
        httpError("notAuthenticated", "Request is not authorized"),
        forbidden ? 403 : 401,
      );
    }

    if (url.pathname === "/api/readyz") {
      const status = dependencies.state.snapshot().service.status;
      return json({ status }, status === "ready" ? 200 : 503);
    }
    if (url.pathname === "/api/bootstrap") {
      return json(dependencies.state.snapshot());
    }
    if (url.pathname === "/api/settings" && dependencies.settings) {
      if (request.method === "GET") return json(await dependencies.settings.read());
      if (request.method === "PUT") {
        let source: string;
        try {
          source = await readBoundedText(request, 16_384);
        } catch {
          return json(httpError("invalidRequest", "Settings are too large"), 413);
        }
        let value: unknown;
        try {
          value = JSON.parse(source);
        } catch {
          value = undefined;
        }
        if (!isRecord(value)) {
          return json(httpError("invalidRequest", "Invalid settings"), 400);
        }
        await dependencies.settings.save(value as unknown as UserSettings);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      return json(httpError("invalidRequest", "Not found"), 404);
    }
    return dependencies.staticRoot
      ? serveStatic(dependencies.staticRoot, url.pathname)
      : new Response("Not found", { status: 404 });
  };
}

export async function authorizeWebRequest(
  request: Request,
  dependencies: WebRequestHandlerDependencies,
): Promise<void> {
  if (dependencies.auth.mode === "local") {
    authorizeLocalRequest(request, dependencies.auth);
    return;
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new Error("notAuthenticated: missing Cloudflare Access assertion");
  }
  await (dependencies.verifyRemote ?? verifyCloudflareToken)(token, dependencies.auth);
  const origin = externalRequestOrigin(request);
  if (!dependencies.auth.origins.includes(origin)) {
    throw new Error("notAuthenticated: origin is not allowed");
  }
}

function externalRequestOrigin(request: Request): string {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (forwardedProto && forwardedHost && !forwardedProto.includes(",") && !forwardedHost.includes(",")) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("request body exceeds limit");
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export interface UpgradeServer {
  upgrade(
    request: Request,
    options?: { data?: { afterSequence?: number } },
  ): boolean;
}

export function createBunFetchHandler(
  dependencies: WebRequestHandlerDependencies & { gateway: BrowserGateway },
): (request: Request, server: UpgradeServer) => Promise<Response | undefined> {
  const http = createWebRequestHandler(dependencies);
  return async (request, server) => {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return http(request);
    }
    try {
      await authorizeWebRequest(request, dependencies);
    } catch (error) {
      const message = error instanceof Error ? error.message : "notAuthenticated";
      return json(
        httpError("notAuthenticated", "Request is not authorized"),
        message.includes("origin") ? 403 : 401,
      );
    }
    const rawAfter = url.searchParams.get("after");
    const afterSequence = rawAfter === null ? undefined : Number(rawAfter);
    const upgraded = server.upgrade(request, {
      data: {
        ...(Number.isSafeInteger(afterSequence) && (afterSequence ?? -1) >= 0
          ? { afterSequence }
          : {}),
      },
    });
    return upgraded
      ? undefined
      : json(
          httpError("internalError", "WebSocket upgrade failed"),
          500,
        );
  };
}

export interface WebSocketLike {
  data: { afterSequence?: number };
  send(value: string): unknown;
}

export function createWebSocketLifecycle(gateway: BrowserGateway): {
  open(socket: WebSocketLike): void;
  message(socket: WebSocketLike, message: string | Uint8Array | ArrayBuffer): Promise<void>;
  close(socket: WebSocketLike): void;
} {
  const connections = new WeakMap<object, { disconnect: () => void; deviceId: string }>();
  return {
    open(socket) {
      const deviceId = crypto.randomUUID();
      const disconnect = gateway.connect(
        (message) => socket.send(encodeServerMessage(message)),
        socket.data.afterSequence,
      );
      connections.set(socket, { disconnect, deviceId });
    },
    async message(socket, message) {
      const source =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(
              message instanceof Uint8Array ? message : new Uint8Array(message),
            );
      await gateway.handleMessage(
        source,
        (response) => socket.send(encodeServerMessage(response)),
        connections.get(socket)?.deviceId,
      );
    },
    close(socket) {
      connections.get(socket)?.disconnect();
      connections.delete(socket);
    },
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function httpError(code: string, message: string, retryable = false): {
  error: { code: string; message: string; retryable: boolean; diagnosticId: string };
} {
  return { error: { code, message, retryable, diagnosticId: crypto.randomUUID() } };
}

async function serveStatic(root: string, pathname: string): Promise<Response> {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const rootPath = path.resolve(root);
  const requestedPath = path.resolve(rootPath, relative);
  const insideRoot = requestedPath === rootPath || requestedPath.startsWith(`${rootPath}${path.sep}`);
  const candidate = insideRoot ? Bun.file(requestedPath) : undefined;
  if (candidate && (await candidate.exists())) {
    return new Response(await candidate.arrayBuffer(), {
      headers: {
        "Cache-Control": relative.includes("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "Content-Type": contentType(requestedPath),
      },
    });
  }
  const index = Bun.file(path.join(rootPath, "index.html"));
  return (await index.exists())
    ? new Response(await index.arrayBuffer(), {
        headers: { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" },
      })
    : new Response("Not found", { status: 404 });
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
