import type { AuthConfig, RemoteAuthConfig } from "../auth/config";
import { verifyCloudflareToken } from "../auth/cloudflare";
import { authorizeLocalRequest } from "../auth/local";
import { encodeServerMessage } from "../../shared/protocol";
import type { BrowserGateway } from "./gateway";
import type { WebState } from "./state";

export interface WebRequestHandlerDependencies {
  auth: AuthConfig;
  state: WebState;
  verifyRemote?: (token: string, config: RemoteAuthConfig) => Promise<unknown>;
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
        {
          error: {
            code: "notAuthenticated",
            message: "Request is not authorized",
            retryable: false,
          },
        },
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
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      return json({ error: { code: "invalidRequest", message: "Not found" } }, 404);
    }
    return new Response("Not found", { status: 404 });
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
  const origin = request.headers.get("origin") ?? "";
  if (!dependencies.auth.origins.includes(origin)) {
    throw new Error("notAuthenticated: origin is not allowed");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new Error("notAuthenticated: missing Cloudflare Access assertion");
  }
  await (dependencies.verifyRemote ?? verifyCloudflareToken)(token, dependencies.auth);
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
        {
          error: {
            code: "notAuthenticated",
            message: "Request is not authorized",
            retryable: false,
          },
        },
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
          { error: { code: "internalError", message: "WebSocket upgrade failed" } },
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
  const disconnectors = new WeakMap<object, () => void>();
  return {
    open(socket) {
      const disconnect = gateway.connect(
        (message) => socket.send(encodeServerMessage(message)),
        socket.data.afterSequence,
      );
      disconnectors.set(socket, disconnect);
    },
    async message(socket, message) {
      const source =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(
              message instanceof Uint8Array ? message : new Uint8Array(message),
            );
      await gateway.handleMessage(source, (response) =>
        socket.send(encodeServerMessage(response)),
      );
    },
    close(socket) {
      disconnectors.get(socket)?.();
      disconnectors.delete(socket);
    },
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
