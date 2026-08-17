import { Activity, MessageSquareText, Rows3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { BrowserSnapshot } from "../shared/protocol";
import { ActivityPanel } from "./components/ActivityPanel";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ThreadSidebar } from "./components/ThreadSidebar";
import type { CodexWebClient, ConnectionStatus } from "./websocket";
import "./styles.css";

export interface AppProps {
  initialSnapshot: BrowserSnapshot;
  initialSettings?: ClientSettings;
  client?: CodexWebClient;
  onSelectThread?: (threadId: string) => void;
  onNewTask?: () => void;
  onSend?: (input: { text: string; cwd: string; model: string }) => void;
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

  useEffect(() => {
    if (!client) return undefined;
    setSnapshot(client.getSnapshot());
    return client.subscribe(setSnapshot);
  }, [client]);

  useEffect(() => client?.subscribeConnection(setConnection), [client]);

  useEffect(() => {
    const selected = snapshot.threads.find((entry) => entry.id === snapshot.loadedThreadId);
    if (selected?.cwd) setCwd(selected.cwd);
  }, [snapshot.loadedThreadId, snapshot.threads]);

  useEffect(() => {
    if (snapshot.models.some((entry) => entry.id === model)) return;
    const next = snapshot.models.find((entry) => entry.id === settings.model)
      ?? snapshot.models.find((entry) => entry.isDefault)
      ?? snapshot.models[0];
    if (next) setModel(next.id);
  }, [model, settings.model, snapshot.models]);

  async function selectThread(threadId: string) {
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
    const input = { text: draft, cwd, model };
    onSend?.(input);
    try {
      setActionError(undefined);
      if (client) {
        let threadId = newTaskMode ? undefined : snapshot.loadedThreadId;
        if (!threadId) {
          const result = (await client.request("thread.start", { cwd, model })) as { id: string };
          threadId = result.id;
          setNewTaskMode(false);
        }
        await client.request("turn.start", { threadId, text: draft });
      }
      const nextSettings = {
        recentDirectories: [cwd, ...settings.recentDirectories.filter((entry) => entry !== cwd)].slice(0, 20),
        model,
      };
      setSettings(nextSettings);
      onPersistSettings?.(nextSettings);
      setDraft("");
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

  function newTask() {
    setNewTaskMode(true);
    setDraft("");
    setMobileView("chat");
    onNewTask?.();
  }

  return (
    <div className="app-shell" data-mobile-view={mobileView}>
      <ThreadSidebar
        connection={connection}
        onNewTask={newTask}
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
            onCwdChange={setCwd}
            onInterrupt={interrupt}
            onModelChange={setModel}
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
