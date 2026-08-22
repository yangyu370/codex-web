import { describe, expect, test } from "bun:test";

import { createJsonlTransport } from "./jsonl-transport";

function transportHarness() {
  const inbound = new TransformStream<Uint8Array, Uint8Array>();
  const inboundWriter = inbound.writable.getWriter();
  const outbound: string[] = [];
  let ended = false;
  const transport = createJsonlTransport(inbound.readable, {
    write(data) {
      const source = typeof data === "string" ? data : new TextDecoder().decode(data);
      outbound.push(source);
      return source.length;
    },
    end() {
      ended = true;
    },
  });

  return { transport, inboundWriter, outbound, ended: () => ended };
}

describe("createJsonlTransport", () => {
  test("reassembles fragmented input and emits each complete JSONL message", async () => {
    const harness = transportHarness();
    const messages: string[] = [];
    harness.transport.onMessage((source) => messages.push(source));

    await harness.inboundWriter.write(new TextEncoder().encode('{"id":1'));
    await harness.inboundWriter.write(
      new TextEncoder().encode('}\n{"method":"ready"}\r\n'),
    );
    await Bun.sleep(0);

    expect(messages).toEqual(['{"id":1}', '{"method":"ready"}']);
    await harness.inboundWriter.close();
  });

  test("frames each outbound message with exactly one newline", async () => {
    const harness = transportHarness();

    await harness.transport.send('{"id":1}');

    expect(harness.outbound).toEqual(['{"id":1}\n']);
    harness.transport.close();
    expect(harness.ended()).toBe(true);
  });

  test("reports stream closure to transport consumers", async () => {
    const harness = transportHarness();
    const reasons: string[] = [];
    harness.transport.onClose((reason) => reasons.push(reason?.message ?? "closed"));

    await harness.inboundWriter.close();
    await Bun.sleep(0);

    expect(reasons).toEqual(["app-server stdout closed"]);
  });

  test("closes instead of buffering a message beyond the 8 MiB limit", async () => {
    const harness = transportHarness();
    const reasons: string[] = [];
    harness.transport.onClose((reason) => reasons.push(reason?.message ?? "closed"));

    await harness.inboundWriter.write(new Uint8Array(8_388_609).fill(97));
    await Bun.sleep(0);

    expect(reasons).toEqual(["JSON-RPC message exceeds 8388608 bytes"]);
  });
});
