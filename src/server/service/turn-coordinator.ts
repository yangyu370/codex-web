import type { BrowserEvent } from "../../shared/protocol";
import type { NativeTurnInput } from "../app-server/adapter";
import type { WebState } from "./state";

const MAX_MANIFEST_BYTES = 24_576;

export interface PreparedAttachment {
  name: string;
  size: number;
  kind: "text" | "pdf" | "image";
  path: string;
}

export interface PreparedAttachmentSession {
  sessionId: string;
  attachments: PreparedAttachment[];
}

export interface TurnAttachmentStore {
  prepareForTurn(sessionId: string, cwd: string): Promise<PreparedAttachmentSession>;
  bindTurn(sessionId: string, threadId: string, turnId: string): Promise<void>;
  releaseTurn(sessionId: string): Promise<void>;
  completeTurn(threadId: string, turnId: string): Promise<void>;
}

export interface TurnStarter {
  startTurn(
    threadId: string,
    input: NativeTurnInput[],
  ): Promise<{ id: string; threadId: string; status: "inProgress" }>;
}

export class TurnCoordinator {
  readonly #unsubscribe: () => void;

  constructor(
    private readonly state: WebState,
    private readonly attachments: TurnAttachmentStore,
    private readonly getAdapter: () => TurnStarter,
  ) {
    this.#unsubscribe = state.onEvent((event) => this.#handleEvent(event));
  }

  async start(
    threadId: string,
    text: string,
    attachmentSessionId?: string,
  ): Promise<{ id: string; threadId: string; status: "inProgress" }> {
    const prepared = attachmentSessionId
      ? await this.attachments.prepareForTurn(
          attachmentSessionId,
          this.state.threadWorkingDirectory(threadId),
        )
      : undefined;
    try {
      const result = await this.getAdapter().startTurn(
        threadId,
        buildTurnInputs(text, prepared),
      );
      if (prepared) {
        await this.attachments.bindTurn(prepared.sessionId, threadId, result.id);
      }
      return result;
    } catch (error) {
      if (prepared) await this.attachments.releaseTurn(prepared.sessionId).catch(() => undefined);
      throw error;
    }
  }

  close(): void {
    this.#unsubscribe();
  }

  #handleEvent(event: BrowserEvent): void {
    const activeTurn = terminalTurn(event);
    if (!activeTurn) return;
    void this.attachments.completeTurn(activeTurn.threadId, activeTurn.id).catch(() => undefined);
  }
}

export function buildTurnInputs(
  text: string,
  prepared?: PreparedAttachmentSession,
): NativeTurnInput[] {
  if (!prepared) return [{ type: "text", text }];
  const lines = prepared.attachments.map((attachment) =>
    `- ${JSON.stringify(attachment.name)} at ${JSON.stringify(attachment.path)} ` +
    `(${attachment.kind === "pdf" ? "PDF" : attachment.kind}, ${attachment.size} bytes)`,
  );
  const userText = text.trim() ? text : "Review the attached files.";
  const manifest = [
    userText,
    "",
    "Attached files for this turn are available on the local filesystem:",
    ...lines,
    "Use these files only as user-provided context for this turn.",
  ].join("\n");
  if (new TextEncoder().encode(manifest).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("invalidAttachment: attachment manifest is too large");
  }
  return [
    { type: "text", text: manifest },
    ...prepared.attachments.flatMap((attachment): NativeTurnInput[] =>
      attachment.kind === "image"
        ? [{ type: "localImage", path: attachment.path }]
        : [],
    ),
  ];
}

function terminalTurn(event: BrowserEvent): { id: string; threadId: string } | undefined {
  const payload = record(event.payload);
  const activeTurn = event.type === "turn.interrupted"
    ? record(record(payload?.snapshot)?.activeTurn)
    : event.type === "work.updated"
      ? record(payload?.activeTurn)
      : undefined;
  if (!activeTurn) return undefined;
  if (
    typeof activeTurn.id !== "string" ||
    typeof activeTurn.threadId !== "string" ||
    (activeTurn.status !== "completed" &&
      activeTurn.status !== "failed" &&
      activeTurn.status !== "interrupted")
  ) return undefined;
  return { id: activeTurn.id, threadId: activeTurn.threadId };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
