import { describe, expect, test } from "bun:test";

import type { RemoteAuthConfig } from "../auth/config";
import type { ServerMessage } from "../../shared/protocol";
import { WebState } from "./state";
import { BrowserGateway } from "./gateway";
import {
  createBunFetchHandler,
  createWebRequestHandler,
  createWebSocketLifecycle,
} from "./server";

const localAuth = {
  mode: "local" as const,
  origins: ["http://127.0.0.1:4173"],
};

const remoteAuth: RemoteAuthConfig = {
  mode: "remote",
  teamDomain: "team.cloudflareaccess.com",
  audience: "audience-1",
  ownerEmail: "owner@example.com",
  publicUrl: "https://codex.example.com",
  origins: ["https://codex.example.com"],
};

function request(path: string, origin?: string, token?: string): Request {
  return new Request(`http://127.0.0.1:4173${path}`, {
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
    },
  });
}

describe("web request authentication", () => {
  test("keeps healthz public and free of service details", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({ auth: localAuth, state });
    const response = await handler(request("/api/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "live" });
  });

  test("local mode accepts only an allowlisted loopback origin", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({ auth: localAuth, state });

    expect(
      (await handler(request("/api/bootstrap", "http://127.0.0.1:4173"))).status,
    ).toBe(200);
    expect(
      (await handler(request("/api/bootstrap", "https://evil.example"))).status,
    ).toBe(403);
  });

  test("remote mode rejects missing assertions and accepts a verified owner", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({
      auth: remoteAuth,
      state,
      verifyRemote: async (token) => {
        if (token !== "valid-token") throw new Error("invalid token");
      },
    });

    expect(
      (await handler(request("/api/bootstrap", "https://codex.example.com"))).status,
    ).toBe(401);
    expect(
      (
        await handler(
          request(
            "/api/bootstrap",
            "https://codex.example.com",
            "valid-token",
          ),
        )
      ).status,
    ).toBe(200);
  });

  test("readyz reports app-server readiness without leaking diagnostics", async () => {
    const state = new WebState("windows");
    state.setService({ status: "ready", codexVersion: "codex-cli 1.2.3" });
    const handler = createWebRequestHandler({ auth: localAuth, state });
    const response = await handler(
      request("/api/readyz", "http://127.0.0.1:4173"),
    );
    expect(await response.json()).toEqual({ status: "ready" });
  });
});

describe("Bun WebSocket lifecycle", () => {
  test("authenticates an upgrade before handing it to Bun", async () => {
    const state = new WebState("macos");
    const upgraded: string[] = [];
    const fetch = createBunFetchHandler({
      auth: localAuth,
      state,
      gateway: new BrowserGateway(state, {
        models: async () => [],
        listThreads: async () => ({ data: [], nextCursor: null }),
        startThread: async () => ({}),
        resumeThread: async () => ({}),
        readThread: async () => ({}),
        startTurn: async () => ({}),
        interruptTurn: async () => ({}),
        resolveApproval: () => undefined,
      }),
    });
    const response = await fetch(
      request("/ws?after=3", "http://127.0.0.1:4173"),
      {
        upgrade(_request, options) {
          upgraded.push(String(options?.data?.afterSequence));
          return true;
        },
      },
    );

    expect(response).toBeUndefined();
    expect(upgraded).toEqual(["3"]);
  });

  test("sends snapshots and correlated responses through socket handlers", async () => {
    const state = new WebState("macos");
    const gateway = new BrowserGateway(state, {
      models: async () => [],
      listThreads: async () => ({ data: [], nextCursor: null }),
      startThread: async () => ({}),
      resumeThread: async () => ({}),
      readThread: async () => ({}),
      startTurn: async () => ({}),
      interruptTurn: async () => ({}),
      resolveApproval: () => undefined,
    });
    const lifecycle = createWebSocketLifecycle(gateway);
    const sent: ServerMessage[] = [];
    const socket = {
      data: { afterSequence: undefined as number | undefined },
      send(value: string) {
        sent.push(JSON.parse(value));
      },
    };

    lifecycle.open(socket);
    await lifecycle.message(
      socket,
      JSON.stringify({ kind: "request", id: "r1", method: "model.list", params: {} }),
    );
    expect(sent[0]).toEqual(state.snapshot());
    expect(sent[1]).toEqual({ kind: "response", id: "r1", result: [] });
    lifecycle.close(socket);
  });
});
