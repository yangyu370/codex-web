import { Activity, MessageSquareText, Rows3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { BrowserSnapshot, DirectoryListing } from "../shared/protocol";
import { ActivityPanel } from "./components/ActivityPanel";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { DirectoryPicker } from "./components/DirectoryPicker";
import { ThreadSidebar } from "./components/ThreadSidebar";
import type { CodexWebClient, ConnectionStatus } from "./websocket";
import {
  AttachmentClient,
  type AttachmentTransport,
  type DraftAttachment,
  type UploadHandle,
} from "./attachments";
import "./styles.css";

const defaultAttachmentClient = new AttachmentClient();

export interface AppProps {
  initialSnapshot: BrowserSnapshot;
  initialSettings?: ClientSettings;
  client?: CodexWebClient;
  attachmentClient?: AttachmentTransport;
  onSelectThread?: (threadId: string) => void;
  onNewTask?: () => void;
  onSend?: (input: { text: string; cwd: string; model: string; attachmentSessionId?: string }) => void;
  onInterrupt?: () => void;
  onResolveApproval?: (id: string, decision: string) => void;
  onPersistSettings?: (settings: ClientSettings) => void;
}

export interface ClientSettings {
  recentDirectories: string[];
  model?: string;
}

export function App({
  initialSnapshot,
  initialSettings = { recentDirectories: [] },
  client,
  attachmentClient = defaultAttachmentClient,
  onSelectThread,
  onNewTask,
  onSend,
  onInterrupt,
  onResolveApproval,
  onPersistSettings,
}: AppProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [settings, setSettings] = useState(initialSettings);
  const [newTaskMode, setNewTaskMode] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [cwd, setCwd] = useState(
    initialSnapshot.threads.find((thread) => thread.id === initialSnapshot.loadedThreadId)?.cwd ??
      initialSettings.recentDirectories[0] ??
      "",
  );
  const [model, setModel] = useState(
    initialSnapshot.models.find((entry) => entry.id === initialSettings.model)?.id ??
      initialSnapshot.models.find((entry) => entry.isDefault)?.id ??
      initialSnapshot.models[0]?.id ??
      "",
  );
  const [mobileView, setMobileView] = useState<"tasks" | "chat" | "activity">("chat");
  const [actionError, setActionError] = useState<string>();
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing>();
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string>();
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const attachmentSessionRef = useRef<
    Awaited<ReturnType<AttachmentTransport["createSession"]>> | undefined
  >(undefined);
  const attachmentSessionPromiseRef = useRef<
    ReturnType<AttachmentTransport["createSession"]> | undefined
  >(undefined);
  const uploadHandlesRef = useRef(new Map<string, UploadHandle>());
  const attachmentGenerationRef = useRef(0);
  const [connection, setConnection] = useState<ConnectionStatus>(
    client?.connectionStatus() ?? "connected",
  );
  const visibleSnapshot = useMemo(
    () => newTaskMode
      ? { ...snapshot, loadedThreadId: undefined, activeTurn: undefined, visibleItems: [], pendingApprovals: [] }
      : snapshot,
    [newTaskMode, snapshot],
  );
  const thread = useMemo(
    () => visibleSnapshot.threads.find((entry) => entry.id === visibleSnapshot.loadedThreadId),
    [visibleSnapshot.loadedThreadId, visibleSnapshot.threads],
  );
  const running = visibleSnapshot.activeTurn?.status === "inProgress";
  const attachmentBlocked = draftAttachments.some((attachment) => attachment.status !== "ready");

  useEffect(() => {
    if (!client) return undefined;
    setSnapshot(client.getSnapshot());
    return client.subscribe(setSnapshot);
  }, [client]);

  useEffect(() => client?.subscribeConnection(setConnection), [client]);

  useEffect(() => {
    if (newTaskMode) return;
    const selected = snapshot.threads.find((entry) => entry.id === snapshot.loadedThreadId);
    if (selected?.cwd && selected.cwd !== cwd) void changeCwd(selected.cwd);
  }, [newTaskMode, snapshot.loadedThreadId, snapshot.threads]);

  useEffect(() => {
    if (snapshot.models.some((entry) => entry.id === model)) return;
    const next = snapshot.models.find((entry) => entry.id === settings.model)
      ?? snapshot.models.find((entry) => entry.isDefault)
      ?? snapshot.models[0];
    if (next) setModel(next.id);
  }, [model, settings.model, snapshot.models]);

  useEffect(() => () => {
    attachmentGenerationRef.current += 1;
    for (const handle of uploadHandlesRef.current.values()) handle.abort();
    uploadHandlesRef.current.clear();
    const session = attachmentSessionRef.current;
    const pending = attachmentSessionPromiseRef.current;
    attachmentSessionRef.current = undefined;
    attachmentSessionPromiseRef.current = undefined;
    void (session ? Promise.resolve(session) : pending)
      ?.then((value) => attachmentClient.cancel(value.id))
      .catch(() => undefined);
  }, [attachmentClient]);

  function updateDraftAttachments(
    update: DraftAttachment[] | ((current: DraftAttachment[]) => DraftAttachment[]),
  ): void {
    const next = typeof update === "function" ? update(draftAttachmentsRef.current) : update;
    draftAttachmentsRef.current = next;
    setDraftAttachments(next);
  }

  async function ensureAttachmentSession() {
    if (attachmentSessionRef.current) return attachmentSessionRef.current;
    if (attachmentSessionPromiseRef.current) return attachmentSessionPromiseRef.current;
    const generation = attachmentGenerationRef.current;
    const promise = attachmentClient.createSession(cwd).then((session) => {
      if (generation === attachmentGenerationRef.current) attachmentSessionRef.current = session;
      return session;
    });
    attachmentSessionPromiseRef.current = promise;
    void promise.finally(() => {
      if (attachmentSessionPromiseRef.current === promise) {
        attachmentSessionPromiseRef.current = undefined;
      }
    }).catch(() => undefined);
    return promise;
  }

  async function discardAttachmentDraft(): Promise<void> {
    attachmentGenerationRef.current += 1;
    for (const handle of uploadHandlesRef.current.values()) handle.abort();
    uploadHandlesRef.current.clear();
    const session = attachmentSessionRef.current;
    const pending = attachmentSessionPromiseRef.current;
    attachmentSessionRef.current = undefined;
    attachmentSessionPromiseRef.current = undefined;
    updateDraftAttachments([]);
    try {
      const created = session ?? await pending;
      if (created) await attachmentClient.cancel(created.id);
    } catch {}
  }

  function consumeAttachmentDraft(): void {
    attachmentGenerationRef.current += 1;
    uploadHandlesRef.current.clear();
    attachmentSessionRef.current = undefined;
    attachmentSessionPromiseRef.current = undefined;
    updateDraftAttachments([]);
  }

  async function addAttachmentFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (!cwd.trim()) {
      setActionError("Choose a working directory before attaching files.");
      return;
    }
    const rows = files.map((file): DraftAttachment => ({
      localId: crypto.randomUUID(),
      file,
      progress: 0,
      status: "uploading",
    }));
    updateDraftAttachments((current) => [...current, ...rows]);
    try {
      const session = await ensureAttachmentSession();
      for (const row of rows) {
        const handle = attachmentClient.upload(session.id, row.file, (progress) => {
          updateDraftAttachments((current) => current.map((attachment) =>
            attachment.localId === row.localId
              ? { ...attachment, progress: Math.max(attachment.progress, progress) }
              : attachment,
          ));
        });
        uploadHandlesRef.current.set(row.localId, handle);
        void handle.promise.then((remote) => {
          uploadHandlesRef.current.delete(row.localId);
          updateDraftAttachments((current) => current.map((attachment) =>
            attachment.localId === row.localId
              ? { ...attachment, progress: 1, status: "ready", remote }
              : attachment,
          ));
        }).catch((error: unknown) => {
          uploadHandlesRef.current.delete(row.localId);
          updateDraftAttachments((current) => current.map((attachment) =>
            attachment.localId === row.localId
              ? { ...attachment, status: "failed", error: errorMessage(error) }
              : attachment,
          ));
        });
      }
    } catch (error) {
      updateDraftAttachments((current) => current.map((attachment) =>
        rows.some((row) => row.localId === attachment.localId)
          ? { ...attachment, status: "failed", error: errorMessage(error) }
          : attachment,
      ));
    }
  }

  async function removeAttachment(attachment: DraftAttachment): Promise<void> {
    uploadHandlesRef.current.get(attachment.localId)?.abort();
    uploadHandlesRef.current.delete(attachment.localId);
    const sessionId = attachmentSessionRef.current?.id;
    try {
      if (sessionId && attachment.remote) {
        await attachmentClient.remove(sessionId, attachment.remote.id);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    }
    const remaining = draftAttachmentsRef.current.filter(
      (entry) => entry.localId !== attachment.localId,
    );
    updateDraftAttachments(remaining);
    if (remaining.length === 0) await discardAttachmentDraft();
  }

  async function selectThread(threadId: string) {
    await discardAttachmentDraft();
    setNewTaskMode(false);
    onSelectThread?.(threadId);
    if (client) {
      try {
        setActionError(undefined);
        await client.request("thread.resume", { threadId });
      } catch (error) {
        setActionError(errorMessage(error));
      }
    }
  }

  async function send() {
    const attachmentSessionId = draftAttachments.some((attachment) => attachment.status === "ready")
      ? attachmentSessionRef.current?.id
      : undefined;
    const input = { text: draft, cwd, model, ...(attachmentSessionId ? { attachmentSessionId } : {}) };
    try {
      setActionError(undefined);
      onSend?.(input);
      if (client) {
        let threadId = newTaskMode ? undefined : snapshot.loadedThreadId;
        if (!threadId) {
          const result = (await client.request("thread.start", { cwd, model })) as { id: string };
          threadId = result.id;
          setNewTaskMode(false);
        }
        await client.request("turn.start", {
          threadId,
          text: draft,
          ...(attachmentSessionId ? { attachmentSessionId } : {}),
        });
      }
      const nextSettings = {
        recentDirectories: [cwd, ...settings.recentDirectories.filter((entry) => entry !== cwd)].slice(0, 20),
        model,
      };
      setSettings(nextSettings);
      onPersistSettings?.(nextSettings);
      setDraft("");
      if (attachmentSessionId) consumeAttachmentDraft();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function interrupt() {
    onInterrupt?.();
    if (client && snapshot.activeTurn) {
      void client.request("turn.interrupt", {
        threadId: snapshot.activeTurn.threadId,
        turnId: snapshot.activeTurn.id,
      }).catch((error: unknown) => setActionError(errorMessage(error)));
    }
  }

  function resolveApproval(id: string, decision: string) {
    onResolveApproval?.(id, decision);
    if (client) {
      void client
        .request("approval.resolve", { approvalId: id, decision })
        .catch((error: unknown) => setActionError(errorMessage(error)));
    }
  }

  async function newTask() {
    await discardAttachmentDraft();
    setNewTaskMode(true);
    setDraft("");
    setMobileView("chat");
    onNewTask?.();
  }

  async function changeCwd(nextCwd: string): Promise<void> {
    if (nextCwd !== cwd && draftAttachmentsRef.current.length > 0) {
      await discardAttachmentDraft();
    }
    setCwd(nextCwd);
  }

  async function browseDirectory(path?: string) {
    if (!client) return;
    setDirectoryPickerOpen(true);
    setDirectoryLoading(true);
    setDirectoryError(undefined);
    try {
      const listing = await client.request(
        "directory.list",
        path ? { path } : {},
      ) as DirectoryListing;
      setDirectoryListing(listing);
    } catch (error) {
      setDirectoryError(errorMessage(error));
    } finally {
      setDirectoryLoading(false);
    }
  }

  return (
    <div className="app-shell" data-mobile-view={mobileView}>
      <ThreadSidebar
        connection={connection}
        onNewTask={() => void newTask()}
        onQueryChange={setQuery}
        onSelect={(threadId) => {
          void selectThread(threadId);
          setMobileView("chat");
        }}
        query={query}
        selectedId={visibleSnapshot.loadedThreadId}
        threads={visibleSnapshot.threads}
      />
      <section className="workspace">
        <AppHeader
          activeTurn={visibleSnapshot.activeTurn}
          cwd={cwd}
          model={snapshot.models.find((entry) => entry.id === model)?.displayName ?? model}
          onInterrupt={interrupt}
          service={visibleSnapshot.service}
          threadTitle={thread?.title}
        />
        {visibleSnapshot.service.error || actionError ? (
          <div className="service-diagnostic" role="alert">
            {actionError ?? visibleSnapshot.service.error?.message}
            {visibleSnapshot.service.error?.diagnosticId ? (
              <small>Diagnostic {visibleSnapshot.service.error.diagnosticId}</small>
            ) : null}
          </div>
        ) : null}
        <main>
          <Conversation items={visibleSnapshot.visibleItems} />
          <Composer
            cwd={cwd}
            disabled={visibleSnapshot.service.status !== "ready"}
            model={model}
            models={visibleSnapshot.models}
            recentDirectories={settings.recentDirectories}
            attachments={draftAttachments}
            attachmentBlocked={attachmentBlocked}
            onCwdChange={(value) => void changeCwd(value)}
            onBrowseDirectory={client ? () => void browseDirectory() : undefined}
            onFilesSelected={(files) => void addAttachmentFiles(files)}
            onInterrupt={interrupt}
            onModelChange={setModel}
            onRemoveAttachment={(attachment) => void removeAttachment(attachment)}
            onSend={() => void send()}
            onValueChange={setDraft}
            running={running}
            value={draft}
          />
        </main>
      </section>
      <ActivityPanel
        approvals={visibleSnapshot.pendingApprovals}
        items={visibleSnapshot.visibleItems}
        onResolveApproval={resolveApproval}
        tokenUsage={visibleSnapshot.tokenUsage}
      />
      {directoryPickerOpen ? (
        <DirectoryPicker
          error={directoryError}
          listing={directoryListing}
          loading={directoryLoading}
          onClose={() => setDirectoryPickerOpen(false)}
          onNavigate={(path) => void browseDirectory(path)}
          onSelect={(path) => {
            void changeCwd(path).then(() => setDirectoryPickerOpen(false));
          }}
        />
      ) : null}
      <nav aria-label="Mobile sections" className="mobile-tabs">
        <button data-active={mobileView === "tasks"} onClick={() => setMobileView("tasks")} type="button">
          <Rows3 size={16} /> Tasks
        </button>
        <button data-active={mobileView === "chat"} onClick={() => setMobileView("chat")} type="button">
          <MessageSquareText size={16} /> Chat
        </button>
        <button data-active={mobileView === "activity"} onClick={() => setMobileView("activity")} type="button">
          <Activity size={16} /> Activity
        </button>
      </nav>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
