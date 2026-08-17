import { MessageSquareCode, PanelLeftClose, Plus, Search } from "lucide-react";

import type { ThreadSummary } from "../../shared/protocol";
import type { ConnectionStatus } from "../websocket";

interface ThreadSidebarProps {
  threads: ThreadSummary[];
  selectedId?: string;
  query: string;
  onQueryChange: (query: string) => void;
  onNewTask: () => void;
  onSelect: (threadId: string) => void;
  connection: ConnectionStatus;
}

export function ThreadSidebar({
  threads,
  selectedId,
  query,
  onQueryChange,
  onNewTask,
  onSelect,
  connection,
}: ThreadSidebarProps) {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? threads.filter((thread) =>
        `${thread.title} ${thread.preview} ${thread.cwd ?? ""}`
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
      <div className="sidebar-section-label">
        <span>Tasks</span>
        <span>{filtered.length}</span>
      </div>
      <div className="thread-list">
        {filtered.length === 0 ? (
          <p className="thread-list__empty">No tasks yet</p>
        ) : (
          filtered.map((thread) => (
            <button
              className="thread-row"
              data-active={thread.id === selectedId}
              key={thread.id}
              onClick={() => onSelect(thread.id)}
              type="button"
            >
              <span className="thread-row__title">{thread.title}</span>
              <span className="thread-row__preview">{thread.preview || thread.cwd}</span>
              <span className="thread-row__time">{relativeTime(thread.updatedAt)}</span>
            </button>
          ))
        )}
      </div>
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

function relativeTime(timestampSeconds: number): string {
  const difference = Math.max(0, Date.now() / 1_000 - timestampSeconds);
  if (difference < 60) return "now";
  if (difference < 3_600) return `${Math.floor(difference / 60)}m`;
  if (difference < 86_400) return `${Math.floor(difference / 3_600)}h`;
  return `${Math.floor(difference / 86_400)}d`;
}
