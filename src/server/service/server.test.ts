import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

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

function request(urlPath: string, origin?: string, token?: string): Request {
  return new Request(`http://127.0.0.1:4173${urlPath}`, {
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
    },
  });
}

describe("web request authentication", () => {
  let staticRoot = "";
  beforeAll(async () => {
    staticRoot = await mkdtemp(nodePath.join(tmpdir(), "codex-web-static-"));
    await Bun.write(nodePath.join(staticRoot, "index.html"), "<main>Codex Web</main>");
    await Bun.write(nodePath.join(staticRoot, "app.js"), "console.log('ready')");
  });
  afterAll(async () => {
    await rm(staticRoot, { recursive: true, force: true });
  });

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

  test("remote mode accepts top-level navigation using the public request origin", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({
      auth: remoteAuth,
      state,
      verifyRemote: async () => undefined,
    });
    const response = await handler(new Request("https://codex.example.com/api/bootstrap", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-token" },
    }));

    expect(response.status).toBe(200);
  });

  test("remote mode recognizes the configured HTTPS origin behind a tunnel", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({ auth: remoteAuth, state, verifyRemote: async () => undefined });
    const response = await handler(new Request("http://codex.example.com/api/bootstrap", {
      headers: {
        "Cf-Access-Jwt-Assertion": "valid-token",
        "X-Forwarded-Proto": "https",
        Host: "codex.example.com",
      },
    }));

    expect(response.status).toBe(200);
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

  test("serves built assets and the SPA fallback after authorization", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({ auth: localAuth, state, staticRoot });
    const asset = await handler(request("/app.js", "http://127.0.0.1:4173"));
    const route = await handler(request("/threads/t1", "http://127.0.0.1:4173"));

    expect(asset.headers.get("Content-Type")).toContain("javascript");
    expect(await route.text()).toBe("<main>Codex Web</main>");
  });

  test("exposes authenticated non-secret settings", async () => {
    const state = new WebState("macos");
    let saved: unknown;
    const handler = createWebRequestHandler({
      auth: localAuth,
      state,
      settings: {
        read: async () => ({ recentDirectories: ["/work"] }),
        save: async (value) => { saved = value; },
      },
    });
    const get = await handler(request("/api/settings", "http://127.0.0.1:4173"));
    const put = await handler(new Request("http://127.0.0.1:4173/api/settings", {
      method: "PUT",
      headers: { Origin: "http://127.0.0.1:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ recentDirectories: ["/next"], model: "gpt-5.6" }),
    }));

    expect(await get.json()).toEqual({ recentDirectories: ["/work"] });
    expect(put.status).toBe(204);
    expect(saved).toEqual({ recentDirectories: ["/next"], model: "gpt-5.6" });
  });

  test("rejects an oversized settings body even when content-length is misleading", async () => {
    const state = new WebState("macos");
    const handler = createWebRequestHandler({
      auth: localAuth,
      state,
      settings: {
        read: async () => ({ recentDirectories: [] }),
        save: async () => undefined,
      },
    });
    const response = await handler(new Request("http://127.0.0.1:4173/api/settings", {
      method: "PUT",
      headers: {
        Origin: "http://127.0.0.1:4173",
        "Content-Type": "application/json",
        "Content-Length": "0",
      },
      body: JSON.stringify({ recentDirectories: ["x".repeat(20_000)] }),
    }));

    expect(response.status).toBe(413);
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
