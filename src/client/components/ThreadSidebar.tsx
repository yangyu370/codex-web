import { MessageSquareCode, PanelLeftClose, Plus, Search } from "lucide-react";

import type { BrowserSnapshot, ThreadSummary } from "../../shared/protocol";
import type { ConnectionStatus } from "../websocket";

interface ThreadSidebarProps {
  threads: ThreadSummary[];
  selectedId?: string;
  query: string;
  onQueryChange: (query: string) => void;
  onNewTask: () => void;
  onSelect: (threadId: string) => void;
  connection: ConnectionStatus;
  service: BrowserSnapshot["service"];
}

export function ThreadSidebar({
  threads,
  selectedId,
  query,
  onQueryChange,
  onNewTask,
  onSelect,
  connection,
  service,
}: ThreadSidebarProps) {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? threads.filter((thread) =>
        `${thread.title} ${thread.preview} ${thread.cwd ?? ""} ${thread.source ?? ""} ${thread.status ?? ""}`
          .toLowerCase()
          .includes(normalized),
      )
    : threads;

  return (
    <nav aria-label="Tasks" className="thread-sidebar">
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <MessageSquareCode size={17} strokeWidth={1.8} />
        </div>
        <span>Codex</span>
        <PanelLeftClose className="brand-row__collapse" size={15} aria-hidden="true" />
      </div>
      <button aria-label="New task" className="new-task-button" onClick={onNewTask} type="button">
        <Plus size={15} />
        New task
        <kbd>⌘ N</kbd>
      </button>
      <label className="thread-search">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">Search tasks</span>
        <input
          aria-label="Search tasks"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search tasks"
          value={query}
        />
      </label>
      <div className="thread-list">
        {filtered.length === 0 ? (
          <p className="thread-list__empty">No tasks yet</p>
        ) : (
          <>
            <ThreadGroup label="Running" threads={filtered.filter((thread) => isLive(thread, service))} selectedId={selectedId} onSelect={onSelect} live />
            <ThreadGroup label="Recent" threads={filtered.filter((thread) => !isLive(thread, service))} selectedId={selectedId} onSelect={onSelect} />
          </>
        )}
      </div>
      {service.platform === "macos" && (service.liveHandoff !== "available" || !filtered.some((thread) => isLive(thread, service))) ? (
        <p className="handoff-hint">Start Web before CLI to make new CLI tasks available for live takeover.</p>
      ) : null}
      <div className="sidebar-footer">
        <span className="user-avatar">Y</span>
        <span className="sidebar-footer__account">
          {connection === "connected" ? "Local Codex" : connection}
        </span>
        <span
          className="status-dot"
          data-status={connection}
          aria-label={connection === "connected" ? "Connected" : connection}
        />
      </div>
    </nav>
  );
}

function ThreadGroup({ label, threads, selectedId, onSelect, live = false }: {
  label: string;
  threads: ThreadSummary[];
  selectedId?: string;
  onSelect: (threadId: string) => void;
  live?: boolean;
}) {
  if (threads.length === 0 && label === "Running") return null;
  return <section className="thread-group" aria-label={label}>
    <div className="sidebar-section-label"><span>{label}</span><span>{threads.length}</span></div>
    {threads.map((thread) => <button className="thread-row" data-active={thread.id === selectedId} key={thread.id} onClick={() => onSelect(thread.id)} type="button">
      <span className="thread-row__title">{thread.title}{live ? <em>LIVE · CLI</em> : null}</span>
      <span className="thread-row__preview">{thread.preview || thread.cwd}</span>
      <span className="thread-row__time">{relativeTime(thread.updatedAt)}</span>
    </button>)}
  </section>;
}

function isLive(thread: ThreadSummary, service: BrowserSnapshot["service"]): boolean {
  return service.liveHandoff === "available" && thread.source === "cli" &&
    thread.canAcceptDirectInput === true && thread.status !== "notLoaded" && thread.status !== "systemError";
}

function relativeTime(timestampSeconds: number): string {
  const difference = Math.max(0, Date.now() / 1_000 - timestampSeconds);
  if (difference < 60) return "now";
  if (difference < 3_600) return `${Math.floor(difference / 60)}m`;
  if (difference < 86_400) return `${Math.floor(difference / 3_600)}h`;
  return `${Math.floor(difference / 86_400)}d`;
}
