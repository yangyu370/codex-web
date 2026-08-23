import { ChevronDown, Folder, MessageSquareCode, PanelLeftClose, Plus, Search } from "lucide-react";

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

interface DirectoryGroup {
  cwd: string;
  label: string;
  threads: ThreadSummary[];
  latestAt: number;
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
  const running = filtered.filter((thread) => isLive(thread, service));
  const directories = groupByDirectory(filtered.filter((thread) => !isLive(thread, service)));

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
            <ThreadGroup label="Running" threads={running} selectedId={selectedId} onSelect={onSelect} live />
            {directories.map((group) => (
              <details className="thread-directory" key={group.cwd} open>
                <summary className="thread-directory__header" title={group.cwd || undefined}>
                  <Folder aria-hidden="true" size={12} />
                  <span className="thread-directory__name">{group.label}</span>
                  <span className="thread-directory__count">{group.threads.length}</span>
                  <ChevronDown aria-hidden="true" className="thread-directory__chevron" size={12} />
                </summary>
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    onSelect={onSelect}
                    selectedId={selectedId}
                    thread={thread}
                  />
                ))}
              </details>
            ))}
          </>
        )}
      </div>
      {service.platform === "macos" && (service.liveHandoff !== "available" || running.length === 0) ? (
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

function groupByDirectory(threads: ThreadSummary[]): DirectoryGroup[] {
  const groups = new Map<string, DirectoryGroup>();
  for (const thread of threads) {
    const cwd = thread.cwd?.trim() ?? "";
    const group = groups.get(cwd) ?? { cwd, label: directoryLabel(cwd), threads: [], latestAt: 0 };
    group.threads.push(thread);
    group.latestAt = Math.max(group.latestAt, thread.updatedAt);
    groups.set(cwd, group);
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, threads: [...group.threads].sort(byLatestActivity) }))
    .sort((a, b) => b.latestAt - a.latestAt);
}

function directoryLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return "No directory";
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? trimmed;
}

function byLatestActivity(a: ThreadSummary, b: ThreadSummary): number {
  return b.updatedAt - a.updatedAt;
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
    {threads.map((thread) => (
      <ThreadRow key={thread.id} live={live} onSelect={onSelect} selectedId={selectedId} thread={thread} />
    ))}
  </section>;
}

function ThreadRow({ thread, selectedId, onSelect, live = false }: {
  thread: ThreadSummary;
  selectedId?: string;
  onSelect: (threadId: string) => void;
  live?: boolean;
}) {
  return <button className="thread-row" data-active={thread.id === selectedId} key={thread.id} onClick={() => onSelect(thread.id)} type="button">
    <span className="thread-row__title">{thread.title}{live ? <em>LIVE · CLI</em> : null}</span>
    <span className="thread-row__preview">{thread.preview || thread.cwd}</span>
    <span className="thread-row__time">{relativeTime(thread.updatedAt)}</span>
  </button>;
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
