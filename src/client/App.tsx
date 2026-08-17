import { Activity, MessageSquareText, Rows3 } from "lucide-react";
import { useMemo, useState } from "react";

import type { BrowserSnapshot } from "../shared/protocol";
import { ActivityPanel } from "./components/ActivityPanel";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ThreadSidebar } from "./components/ThreadSidebar";
import "./styles.css";

export interface AppProps {
  initialSnapshot: BrowserSnapshot;
  onSelectThread?: (threadId: string) => void;
  onNewTask?: () => void;
  onSend?: (input: { text: string; cwd: string; model: string }) => void;
  onInterrupt?: () => void;
  onResolveApproval?: (id: string, decision: string) => void;
}

export function App({
  initialSnapshot,
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
          onSelectThread?.(threadId);
          setMobileView("chat");
        }}
        query={query}
        selectedId={snapshot.loadedThreadId}
        threads={snapshot.threads}
      />
      <section className="workspace">
        <AppHeader
          activeTurn={snapshot.activeTurn}
          onInterrupt={onInterrupt}
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
            onInterrupt={() => onInterrupt?.()}
            onModelChange={setModel}
            onSend={() => {
              onSend?.({ text: draft, cwd, model });
              setDraft("");
            }}
            onValueChange={setDraft}
            running={running}
            value={draft}
          />
        </main>
      </section>
      <ActivityPanel
        approvals={snapshot.pendingApprovals}
        items={snapshot.visibleItems}
        onResolveApproval={onResolveApproval}
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

