import { expect, test } from "bun:test";

import { JsonRpcPeer } from "../../src/server/app-server/json-rpc";
import { connectTcpWebSocket } from "../../src/server/app-server/tcp-websocket-transport";

test("fake loopback app-server broadcasts across clients and survives a disconnect", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const endpoint = `ws://127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  const child = Bun.spawn([
    "bun",
    "tests/fixtures/fake-codex.ts",
    "app-server",
    "--listen",
    endpoint,
  ], { stdout: "ignore", stderr: "pipe" });
  let first: JsonRpcPeer | undefined;
  let second: JsonRpcPeer | undefined;
  try {
    first = await connectPeer(endpoint);
    second = await connectPeer(endpoint);
    await Promise.all([initialize(first), initialize(second)]);

    const observedThread = notification(second, "thread/started");
    const started = await first.request("thread/start", { cwd: "/work/shared" }) as {
      thread?: { id?: string };
    };
    expect((await observedThread).params).toMatchObject({
      thread: { id: started.thread?.id },
    });

    first.close(new Error("first fake client disconnected"));
    first = undefined;
    await expect(second.request("thread/read", {
      threadId: "private-cli",
      includeTurns: true,
    })).resolves.toMatchObject({ thread: { id: "private-cli" } });

    second.onServerRequest((request) => second?.respond(request.id, { decision: "accept" }));
    const completed = notification(second, "turn/completed");
    await expect(second.request("turn/start", {
      threadId: "shared-cli",
      input: [{ type: "text", text: "Continue from observer" }],
    })).resolves.toMatchObject({ turn: { status: "inProgress" } });
    expect((await completed).params).toMatchObject({
      threadId: "shared-cli",
      turn: { status: "completed" },
    });
  } finally {
    first?.close();
    second?.close();
    child.kill("SIGTERM");
    await child.exited;
  }
});

async function connectPeer(endpoint: string): Promise<JsonRpcPeer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return new JsonRpcPeer(await connectTcpWebSocket(endpoint), { requestTimeoutMs: 2_000 });
    } catch (error) {
      lastError = error;
      await Bun.sleep(10);
    }
  }
  throw lastError;
}

async function initialize(peer: JsonRpcPeer): Promise<void> {
  await peer.request("initialize", {
    clientInfo: { name: "fake-integration", version: "1" },
    capabilities: { experimentalApi: true },
  });
  peer.notify("initialized");
}

function notification(peer: JsonRpcPeer, method: string) {
  return new Promise<{ method: string; params: unknown }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${method}`));
    }, 2_000);
    const unsubscribe = peer.onNotification((value) => {
      if (value.method !== method) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(value);
    });
  });
}
