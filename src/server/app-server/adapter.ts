import {
  JsonRpcResponseError,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./json-rpc";
import type { WebState } from "../service/state";
import type { ValidatedPath } from "../platform";
import {
  decodeModelList,
  decodeThreadEnvelope,
  decodeThreadList,
  decodeTurns,
  optionalString,
  record,
} from "./decoders";

export interface RpcClient {
  request(method: string, params: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  respondError?(id: string | number, error: { code: number; message: string }): void;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void;
  onProtocolError?(listener: (error: Error) => void): () => void;
}

export interface WorkingDirectoryValidator {
  validateWorkingDirectory(input: string): Promise<ValidatedPath>;
}

export type NativeTurnInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export class CodexAdapter {
  readonly #rpc: RpcClient;
  readonly #state: WebState;
  readonly #platform?: WorkingDirectoryValidator;

  constructor(
    rpc: RpcClient,
    state: WebState,
    platform?: WorkingDirectoryValidator,
  ) {
    this.#rpc = rpc;
    this.#state = state;
    this.#platform = platform;
    rpc.onNotification((notification) => state.applyNotification(notification));
    rpc.onProtocolError?.((error) => state.addDiagnostic(error.message));
    rpc.onServerRequest((request) => {
      try {
        state.addApproval(request);
      } catch (error) {
        rpc.respondError?.(request.id, {
          code: -32001,
          message: "Codex Web could not retain this approval request",
        });
        state.addDiagnostic(
          `${request.method}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  async models(): Promise<ReturnType<typeof decodeModelList>> {
    const models = decodeModelList(await this.#request("model/list", {}));
    this.#state.setModels(models);
    return models;
  }

  async listThreads(cursor?: string): Promise<{
    data: ReturnType<typeof decodeThreadList>["data"];
    nextCursor: string | null;
  }> {
    const response = decodeThreadList(
      await this.#request("thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    );
    this.#state.setThreads(response.data);
    return response;
  }

  async startThread(params: {
    cwd: string;
    model?: string;
  }): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    if (!this.#platform) {
      throw new Error("invalidWorkingDirectory: host platform unavailable");
    }
    const cwd = await this.#platform.validateWorkingDirectory(params.cwd);
    const decoded = decodeThreadEnvelope(
      await this.#request("thread/start", {
        cwd: cwd.resolvedPath,
        ...(params.model ? { model: params.model } : {}),
      }),
    );
    const thread = { ...decoded.thread, cwd: cwd.displayPath };
    this.#state.upsertThread(thread);
    this.#state.loadThread(thread.id, decoded.items);
    return thread;
  }

  async resumeThread(
    threadId: string,
  ): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    try {
      const response = record(await this.#request("thread/resume", {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" },
      }), "thread/resume response");
      const rawThread = record(response.thread, "thread/resume response.thread");
      const decoded = decodeThreadEnvelope({ thread: rawThread });
      let items: ReturnType<typeof decodeTurns> = [];
      let pageValue: unknown = response.initialTurnsPage;
      let pages = 0;
      const seenCursors = new Set<string>();
      while (pageValue !== undefined && pageValue !== null && pages < 50) {
        const page = record(pageValue, "thread/turns/list response");
        const turns = Array.isArray(page.data) ? page.data : [];
        const pageItems = decodeTurns([...turns].reverse());
        items = [...pageItems, ...items].slice(-500);
        const cursor = optionalString(page.nextCursor);
        if (!cursor || seenCursors.has(cursor) || items.length >= 500) break;
        seenCursors.add(cursor);
        pageValue = await this.#request("thread/turns/list", {
          threadId,
          cursor,
          limit: 10,
          sortDirection: "desc",
          itemsView: "full",
        });
        pages += 1;
      }
      this.#state.upsertThread(decoded.thread);
      this.#state.loadThread(decoded.thread.id, items);
      return decoded.thread;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("compatibilityError:")) throw error;
      return this.#loadThread("thread/resume", { threadId });
    }
  }

  async readThread(
    threadId: string,
  ): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    return this.#loadThread("thread/read", { threadId, includeTurns: true });
  }

  async startTurn(
    threadId: string,
    input: NativeTurnInput[],
  ): Promise<{ id: string; threadId: string; status: "inProgress" }> {
    if (
      input.length === 0 ||
      !input.some((item) => item.type === "text" && item.text.trim()) ||
      input.some((item) => item.type === "localImage" && !item.path)
    ) {
      throw new Error("invalidRequest: turn text is empty");
    }
    const response = record(
      await this.#request("turn/start", {
        threadId,
        input,
      }),
      "turn/start response",
    );
    const turn = record(response.turn, "turn/start response.turn");
    const id = optionalString(turn.id);
    if (!id) {
      throw new Error("compatibilityError: turn.id");
    }
    this.#state.applyNotification({
      method: "turn/started",
      params: { threadId, turn: { ...turn, id } },
    });
    return { id, threadId, status: "inProgress" };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    await this.#request("turn/interrupt", { threadId, turnId });
    return {};
  }

  resolveApproval(id: string, decision: string, deviceId = "browser"): void {
    const approval = this.#state.claimApproval(id, decision, deviceId);
    if (
      approval.method === "item/commandExecution/requestApproval" ||
      approval.method === "item/fileChange/requestApproval"
    ) {
      this.#rpc.respond(approval.requestId, { decision });
      return;
    }
    if (approval.method === "item/permissions/requestApproval") {
      const requested =
        typeof approval.params.permissions === "object" &&
        approval.params.permissions !== null
          ? approval.params.permissions
          : {};
      this.#rpc.respond(approval.requestId, {
        permissions: decision === "decline" ? {} : requested,
        scope: decision === "grantSession" ? "session" : "turn",
      });
      return;
    }
    throw new Error(`compatibilityError: ${approval.method}`);
  }

  async #loadThread(
    method: "thread/resume" | "thread/read",
    params: Record<string, unknown>,
  ): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    const decoded = decodeThreadEnvelope(await this.#request(method, params));
    this.#state.upsertThread(decoded.thread);
    this.#state.loadThread(decoded.thread.id, decoded.items);
    return decoded.thread;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.#rpc.request(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.addDiagnostic(`${method}: ${message}`);
      const lower = message.toLowerCase();
      if (
        (error instanceof JsonRpcResponseError && (error.code === -32601 || error.code === -32602)) ||
        lower.includes("method not found") ||
        lower.includes("unknown method") ||
        lower.includes("unknown variant")
      ) {
        throw new Error(`compatibilityError: ${method}`);
      }
      if (error instanceof JsonRpcResponseError && error.code === -32001) {
        throw new Error(`codexRejected: retryable overload in ${method}`);
      }
      if (
        lower.includes("transport is closed") ||
        lower.includes("stdout closed") ||
        lower.includes("app-server exited") ||
        lower.includes("app-server stopped")
      ) {
        throw new Error(`interrupted: ${method}`);
      }
      throw new Error(`codexRejected: ${method}`);
    }
  }
}
