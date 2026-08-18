import type {
  AttachmentSessionSummary,
  AttachmentSummary,
} from "../shared/protocol";

export interface UploadHandle {
  promise: Promise<AttachmentSummary>;
  abort(): void;
}

export interface AttachmentTransport {
  createSession(cwd: string): Promise<AttachmentSessionSummary>;
  upload(
    sessionId: string,
    file: File,
    onProgress: (progress: number) => void,
  ): UploadHandle;
  remove(sessionId: string, attachmentId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export interface DraftAttachment {
  localId: string;
  file: File;
  progress: number;
  status: "uploading" | "ready" | "failed";
  remote?: AttachmentSummary;
  error?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AttachmentClient implements AttachmentTransport {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly createXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
  ) {}

  createSession(cwd: string): Promise<AttachmentSessionSummary> {
    return this.#request("/api/attachment-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  }

  upload(
    sessionId: string,
    file: File,
    onProgress: (progress: number) => void,
  ): UploadHandle {
    const xhr = this.createXhr();
    const query = new URLSearchParams({ name: file.name });
    let latestProgress = 0;
    const promise = new Promise<AttachmentSummary>((resolve, reject) => {
      xhr.open("POST", `/api/attachment-sessions/${sessionId}/files?${query}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        const next = Math.min(1, event.loaded / event.total);
        if (next <= latestProgress) return;
        latestProgress = next;
        onProgress(next);
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(responseError(xhr.responseText, xhr.status));
          return;
        }
        try {
          const result = JSON.parse(xhr.responseText) as AttachmentSummary;
          if (latestProgress < 1) onProgress(1);
          resolve(result);
        } catch {
          reject(new Error("The upload response was invalid."));
        }
      };
      xhr.onerror = () => reject(new Error("The attachment upload failed."));
      xhr.onabort = () => reject(new Error("The attachment upload was cancelled."));
      xhr.send(file);
    });
    return { promise, abort: () => xhr.abort() };
  }

  async remove(sessionId: string, attachmentId: string): Promise<void> {
    await this.#request(`/api/attachment-sessions/${sessionId}/files/${attachmentId}`, {
      method: "DELETE",
    }, false);
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#request(`/api/attachment-sessions/${sessionId}`, {
      method: "DELETE",
    }, false);
  }

  async #request<T>(url: string, init: RequestInit, parse = true): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(url, { ...init, credentials: "same-origin" });
    if (!response.ok) throw responseError(await response.text(), response.status);
    return (parse ? await response.json() : undefined) as T;
  }
}

function responseError(source: string, status: number): Error {
  try {
    const value = JSON.parse(source) as { error?: { message?: unknown } };
    if (typeof value.error?.message === "string") return new Error(value.error.message);
  } catch {}
  return new Error(`Attachment request failed with ${status}.`);
}
