import type { JsonRpcNotification, JsonRpcServerRequest } from "./json-rpc";
import type { WebState } from "../service/state";
import type { ValidatedPath } from "../platform";
import {
  decodeModelList,
  decodeThreadEnvelope,
  decodeThreadList,
  optionalString,
  record,
} from "./decoders";

export interface RpcClient {
  request(method: string, params: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void;
}

export interface WorkingDirectoryValidator {
  validateWorkingDirectory(input: string): Promise<ValidatedPath>;
}

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
    rpc.onServerRequest((request) => {
      try {
        state.addApproval(request);
      } catch (error) {
        state.addDiagnostic(
          `${request.method}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  async models(): Promise<ReturnType<typeof decodeModelList>> {
    const models = decodeModelList(await this.#rpc.request("model/list", {}));
    this.#state.setModels(models);
    return models;
  }

  async listThreads(cursor?: string): Promise<{
    data: ReturnType<typeof decodeThreadList>["data"];
    nextCursor: string | null;
  }> {
    const response = decodeThreadList(
      await this.#rpc.request("thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        sortKey: "updatedAt",
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
      await this.#rpc.request("thread/start", {
        cwd: cwd.resolvedPath,
        ...(params.model ? { model: params.model } : {}),
      }),
    );
    this.#state.upsertThread(decoded.thread);
    this.#state.loadThread(decoded.thread.id, decoded.items);
    return decoded.thread;
  }

  async resumeThread(
    threadId: string,
  ): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    return this.#loadThread("thread/resume", { threadId });
  }

  async readThread(
    threadId: string,
  ): Promise<ReturnType<typeof decodeThreadEnvelope>["thread"]> {
    return this.#loadThread("thread/read", { threadId, includeTurns: true });
  }

  async startTurn(
    threadId: string,
    text: string,
  ): Promise<{ id: string; threadId: string; status: "inProgress" }> {
    if (!text.trim()) {
      throw new Error("invalidRequest: turn text is empty");
    }
    const response = record(
      await this.#rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
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
    return this.#rpc.request("turn/interrupt", { threadId, turnId });
  }

  resolveApproval(id: string, decision: string): void {
    const approval = this.#state.claimApproval(id, decision);
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
    const decoded = decodeThreadEnvelope(await this.#rpc.request(method, params));
    this.#state.upsertThread(decoded.thread);
    this.#state.loadThread(decoded.thread.id, decoded.items);
    return decoded.thread;
  }
}
