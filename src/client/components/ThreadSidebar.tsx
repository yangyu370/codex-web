import { ChevronDown, Folder, MessageSquareCode, PanelLeftClose, Plus, Search } from "lucide-react";

import type { BrowserSnapshot, ThreadAccess, ThreadSummary } from "../../shared/protocol";
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
  threadAccess?: ThreadAccess;
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
  threadAccess,
}: ThreadSidebarProps) {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? threads.filter((thread) =>
        `${thread.title} ${thread.preview} ${thread.cwd ?? ""} ${thread.source ?? ""} ${thread.status ?? ""}`
          .toLowerCase()
          .includes(normalized),
      )
    : threads;
  const running = filtered.filter((thread) => isLive(thread, service, threadAccess));
  const directories = groupByDirectory(filtered.filter((thread) => !isLive(thread, service, threadAccess)));

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
            <ThreadGroup label="Running" threads={running} selectedId={selectedId} onSelect={onSelect} service={service} threadAccess={threadAccess} />
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
                    service={service}
                    thread={thread}
                    threadAccess={threadAccess}
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
          {serviceLabel(connection, service)}
        </span>
        <span
          className="status-dot"
          data-status={connection}
          aria-label={serviceLabel(connection, service)}
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

function ThreadGroup({ label, threads, selectedId, onSelect, service, threadAccess }: {
  label: string;
  threads: ThreadSummary[];
  selectedId?: string;
  onSelect: (threadId: string) => void;
  service: BrowserSnapshot["service"];
  threadAccess?: ThreadAccess;
}) {
  if (threads.length === 0 && label === "Running") return null;
  return <section className="thread-group" aria-label={label}>
    <div className="sidebar-section-label"><span>{label}</span><span>{threads.length}</span></div>
    {threads.map((thread) => (
      <ThreadRow key={thread.id} onSelect={onSelect} selectedId={selectedId} service={service} thread={thread} threadAccess={threadAccess} />
    ))}
  </section>;
}

function ThreadRow({ thread, selectedId, onSelect, service, threadAccess }: {
  thread: ThreadSummary;
  selectedId?: string;
  onSelect: (threadId: string) => void;
  service: BrowserSnapshot["service"];
  threadAccess?: ThreadAccess;
}) {
  const badge = threadBadge(thread, service, threadAccess);
  return <button className="thread-row" data-active={thread.id === selectedId} key={thread.id} onClick={() => onSelect(thread.id)} type="button">
    <span className="thread-row__title">{thread.title}{badge ? <em data-tone={badge.tone}>{badge.label}</em> : null}</span>
    <span className="thread-row__preview">{thread.preview || thread.cwd}</span>
    <span className="thread-row__time">{relativeTime(thread.updatedAt)}</span>
  </button>;
}

function isLive(
  thread: ThreadSummary,
  service: BrowserSnapshot["service"],
  access?: ThreadAccess,
): boolean {
  return service.liveHandoff === "available" && thread.source === "cli" &&
    access?.threadId === thread.id && access.mode === "readWrite" &&
    thread.canAcceptDirectInput === true && thread.status !== "notLoaded" && thread.status !== "systemError";
}

function threadBadge(
  thread: ThreadSummary,
  service: BrowserSnapshot["service"],
  access?: ThreadAccess,
): { label: string; tone: "live" | "readonly" } | undefined {
  if (isLive(thread, service, access)) return { label: "LIVE · CLI", tone: "live" };
  if (
    thread.source === "cli" && access?.threadId === thread.id &&
    access.mode === "historyOnly" && access.reason === "activeWriter"
  ) {
    return { label: "READ ONLY · LOCAL CLI", tone: "readonly" };
  }
  return undefined;
}

function serviceLabel(connection: ConnectionStatus, service: BrowserSnapshot["service"]): string {
  if (connection !== "connected") {
    return connection === "closed" ? "Unavailable" : "Reconnecting";
  }
  if (service.status === "unavailable") return "Unavailable";
  if (service.status !== "ready") return "Reconnecting";
  return service.liveHandoff === "available" ? "Shared Codex" : "Local Codex";
}

function relativeTime(timestampSeconds: number): string {
  const difference = Math.max(0, Date.now() / 1_000 - timestampSeconds);
  if (difference < 60) return "now";
  if (difference < 3_600) return `${Math.floor(difference / 60)}m`;
  if (difference < 86_400) return `${Math.floor(difference / 3_600)}h`;
  return `${Math.floor(difference / 86_400)}d`;
}
