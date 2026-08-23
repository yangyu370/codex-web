import {
  JsonRpcResponseError,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./json-rpc";
import type { WebState } from "../service/state";
import type { ValidatedPath } from "../platform";
import type { BrowserSnapshot } from "../../shared/protocol";
import {
  decodeModelList,
  decodePermissionProfileList,
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

// Turns are fetched newest-first in pages; larger pages cut sequential
// round trips when loading long sessions (the 500-item cap still bounds work).
const RESUME_PAGE_LIMIT = 50;

export class CodexAdapter {
  readonly #rpc: RpcClient;
  readonly #state: WebState;
  readonly #platform?: WorkingDirectoryValidator;
  #permissionProfiles: ReturnType<typeof decodePermissionProfileList> = [];

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
        const params = record(request.params, `${request.method}.params`);
        const threadId = optionalString(params.threadId);
        if (threadId && !state.isLoadedThread(threadId)) return;
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

  async permissionProfiles(): Promise<ReturnType<typeof decodePermissionProfileList>> {
    const profiles = decodePermissionProfileList(
      await this.#request("permissionProfile/list", {}),
    );
    this.#permissionProfiles = profiles;
    this.#state.setPermissionProfiles(profiles);
    return profiles;
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
    if (decoded.settings) this.#state.setThreadSettings(decoded.settings);
    return thread;
  }

  async resumeThread(
    threadId: string,
  ): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    const startedAt = Date.now();
    try {
      const response = record(await this.#request("thread/resume", {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: RESUME_PAGE_LIMIT, sortDirection: "desc", itemsView: "full" },
      }), "thread/resume response");
      const rawThread = record(response.thread, "thread/resume response.thread");
      const decoded = decodeThreadEnvelope({ thread: rawThread });
      let items: ReturnType<typeof decodeTurns> = [];
      let activeTurn: BrowserSnapshot["activeTurn"];
      let pageValue: unknown = response.initialTurnsPage;
      let pages = 0;
      const seenCursors = new Set<string>();
      while (pageValue !== undefined && pageValue !== null && pages < 50) {
        const page = record(pageValue, "thread/turns/list response");
        const turns = Array.isArray(page.data) ? page.data : [];
        activeTurn ??= activeTurnFrom(turns, decoded.thread.id);
        const pageItems = decodeTurns([...turns].reverse());
        items = [...pageItems, ...items].slice(-500);
        const cursor = optionalString(page.nextCursor);
        if (!cursor || seenCursors.has(cursor) || items.length >= 500) break;
        seenCursors.add(cursor);
        pageValue = await this.#request("thread/turns/list", {
          threadId,
          cursor,
          limit: RESUME_PAGE_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
        });
        pages += 1;
      }
      this.#state.addDiagnostic(
        `resume ${threadId}: pages=${pages + 1} items=${items.length} totalMs=${Date.now() - startedAt}`,
      );
      this.#state.upsertThread(decoded.thread);
      this.#state.loadThread(decoded.thread.id, items, activeTurn);
      const runtime = decodeThreadEnvelope(response).settings;
      if (runtime) this.#state.setThreadSettings(runtime);
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
    settings: {
      model?: string;
      effort?: string;
      permissionProfile?: string;
    } = {},
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
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.permissionProfile ? { permissions: settings.permissionProfile } : {}),
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

  async updateThreadSettings(
    threadId: string,
    settings: { effort?: string; permissionProfile?: string },
  ): Promise<unknown> {
    if (!settings.effort && !settings.permissionProfile) {
      throw new Error("invalidRequest: task settings update is empty");
    }
    if (settings.permissionProfile) {
      const profile = this.#permissionProfiles.find(
        (entry) => entry.id === settings.permissionProfile,
      );
      if (!profile || !profile.allowed) {
        throw new Error("invalidRequest: permission profile is unavailable");
      }
    }
    await this.#request("thread/settings/update", {
      threadId,
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.permissionProfile ? { permissions: settings.permissionProfile } : {}),
    });
    return {};
  }

  async startReview(threadId: string): Promise<{
    threadId: string;
    turnId: string;
    status: "inProgress";
  }> {
    const response = record(await this.#request("review/start", {
      threadId,
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    }), "review/start response");
    const turn = record(response.turn, "review/start response.turn");
    const turnId = optionalString(turn.id);
    const reviewThreadId = optionalString(response.reviewThreadId);
    if (!turnId || !reviewThreadId) {
      throw new Error("compatibilityError: review/start response");
    }
    const review = { threadId: reviewThreadId, turnId, status: "inProgress" as const };
    if (this.#state.snapshot().loadedThreadId === threadId) {
      this.#state.setReview(review);
      this.#state.applyNotification({
        method: "turn/started",
        params: { threadId: reviewThreadId, turn: { ...turn, id: turnId } },
      });
    }
    return review;
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
    const response = await this.#request(method, params);
    const decoded = decodeThreadEnvelope(response);
    const rawResponse = record(response, `${method} response`);
    const rawThread = record(rawResponse.thread, `${method} response.thread`);
    const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
    this.#state.upsertThread(decoded.thread);
    this.#state.loadThread(decoded.thread.id, decoded.items, activeTurnFrom(turns, decoded.thread.id));
    if (decoded.settings) this.#state.setThreadSettings(decoded.settings);
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

function activeTurnFrom(
  turns: unknown[],
  threadId: string,
): BrowserSnapshot["activeTurn"] {
  for (const value of turns) {
    try {
      const turn = record(value, "thread.turn");
      const id = optionalString(turn.id);
      const status = optionalString(turn.status);
      if (id && id.length <= 512 && status === "inProgress") {
        return { id, threadId, status: "inProgress" };
      }
    } catch {}
  }
  return undefined;
}
