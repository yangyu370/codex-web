import { Activity, MessageSquareText, Rows3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { BrowserSnapshot } from "../shared/protocol";
import { ActivityPanel } from "./components/ActivityPanel";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ThreadSidebar } from "./components/ThreadSidebar";
import type { CodexWebClient } from "./websocket";
import "./styles.css";

export interface AppProps {
  initialSnapshot: BrowserSnapshot;
  client?: CodexWebClient;
  onSelectThread?: (threadId: string) => void;
  onNewTask?: () => void;
  onSend?: (input: { text: string; cwd: string; model: string }) => void;
  onInterrupt?: () => void;
  onResolveApproval?: (id: string, decision: string) => void;
}

export function App({
  initialSnapshot,
  client,
  onSelectThread,
  onNewTask,
  onSend,
  onInterrupt,
  onResolveApproval,
}: AppProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [cwd, setCwd] = useState(
    initialSnapshot.threads.find((thread) => thread.id === initialSnapshot.loadedThreadId)?.cwd ?? "",
  );
  const [model, setModel] = useState(
    initialSnapshot.models.find((entry) => entry.isDefault)?.id ??
      initialSnapshot.models[0]?.id ??
      "",
  );
  const [mobileView, setMobileView] = useState<"tasks" | "chat" | "activity">("chat");
  const thread = useMemo(
    () => snapshot.threads.find((entry) => entry.id === snapshot.loadedThreadId),
    [snapshot.loadedThreadId, snapshot.threads],
  );
  const running = snapshot.activeTurn?.status === "inProgress";

  useEffect(() => {
    if (!client) return undefined;
    setSnapshot(client.getSnapshot());
    return client.subscribe(setSnapshot);
  }, [client]);

  async function selectThread(threadId: string) {
    onSelectThread?.(threadId);
    if (client) await client.request("thread.resume", { threadId });
  }

  async function send() {
    const input = { text: draft, cwd, model };
    onSend?.(input);
    if (client) {
      let threadId = snapshot.loadedThreadId;
      if (!threadId) {
        const result = (await client.request("thread.start", { cwd, model })) as { id: string };
        threadId = result.id;
      }
      await client.request("turn.start", { threadId, text: draft });
    }
    setDraft("");
  }

  function interrupt() {
    onInterrupt?.();
    if (client && snapshot.activeTurn) {
      void client.request("turn.interrupt", {
        threadId: snapshot.activeTurn.threadId,
        turnId: snapshot.activeTurn.id,
      });
    }
  }

  function resolveApproval(id: string, decision: string) {
    onResolveApproval?.(id, decision);
    if (client) void client.request("approval.resolve", { approvalId: id, decision });
  }

  function newTask() {
    setSnapshot((current) => ({
      ...current,
      loadedThreadId: undefined,
      visibleItems: [],
      activeTurn: undefined,
      pendingApprovals: [],
    }));
    setDraft("");
    setMobileView("chat");
    onNewTask?.();
  }

  return (
    <div className="app-shell" data-mobile-view={mobileView}>
      <ThreadSidebar
        onNewTask={newTask}
        onQueryChange={setQuery}
        onSelect={(threadId) => {
          void selectThread(threadId);
          setMobileView("chat");
        }}
        query={query}
        selectedId={snapshot.loadedThreadId}
        threads={snapshot.threads}
      />
      <section className="workspace">
        <AppHeader
          activeTurn={snapshot.activeTurn}
          onInterrupt={interrupt}
          service={snapshot.service}
          threadTitle={thread?.title}
        />
        <main>
          <Conversation items={snapshot.visibleItems} />
          <Composer
            cwd={cwd}
            disabled={snapshot.service.status !== "ready"}
            model={model}
            models={snapshot.models}
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
        approvals={snapshot.pendingApprovals}
        items={snapshot.visibleItems}
        onResolveApproval={resolveApproval}
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
