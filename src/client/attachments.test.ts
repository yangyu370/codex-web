import { describe, expect, test } from "bun:test";

import { AttachmentClient } from "./attachments";

describe("AttachmentClient", () => {
  test("creates and cancels an authenticated server attachment session", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AttachmentClient(async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        id: "session-1",
        expiresAt: 1_700_000_000,
        limits: { files: 10, fileBytes: 20, totalBytes: 50 },
      }, { status: 201 });
    });

    await expect(client.createSession("/server/project")).resolves.toMatchObject({ id: "session-1" });
    await client.cancel("session-1");

    expect(requests.map(({ url, init }) => ({ url, method: init?.method, body: init?.body }))).toEqual([
      {
        url: "/api/attachment-sessions",
        method: "POST",
        body: JSON.stringify({ cwd: "/server/project" }),
      },
      {
        url: "/api/attachment-sessions/session-1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  test("uploads raw bytes, reports monotonic progress, and can abort", async () => {
    const xhr = new FakeXhr();
    const client = new AttachmentClient(fetch, () => xhr as unknown as XMLHttpRequest);
    const values: number[] = [];
    const file = new File(["0123456789"], "notes & plan.ts", { type: "text/plain" });

    const handle = client.upload("session-1", file, (value) => values.push(value));
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 10 } as ProgressEvent);
    xhr.respond(201, { id: "a1", name: "notes & plan.ts", size: 10, kind: "text" });

    await expect(handle.promise).resolves.toMatchObject({ id: "a1" });
    expect(values).toEqual([0.5, 1]);
    expect(xhr.url).toBe("/api/attachment-sessions/session-1/files?name=notes+%26+plan.ts");
    expect(xhr.sent).toBe(file);
    handle.abort();
    expect(xhr.aborted).toBe(true);
  });
});

class FakeXhr {
  status = 0;
  responseText = "";
  url = "";
  sent?: Document | XMLHttpRequestBodyInit | null;
  aborted = false;
  withCredentials = false;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string): void { this.url = url; }
  setRequestHeader(): void {}
  send(body?: Document | XMLHttpRequestBodyInit | null): void { this.sent = body; }
  abort(): void { this.aborted = true; this.onabort?.(); }
  respond(status: number, value: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(value);
    this.onload?.();
  }
}
