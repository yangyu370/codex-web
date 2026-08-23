import { CheckCircle2, ChevronRight, FileCode2, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { VisibleItem } from "../../shared/protocol";

interface ConversationProps {
  items: VisibleItem[];
  onOpenChanges?: () => void;
}

// Long sessions can carry hundreds of items; older ones render as one-line
// previews and only expand (markdown, command output) once they approach the
// viewport, so opening a session does not parse every message up front.
const FULL_RENDER_ITEM_WINDOW = 40;

export function Conversation({ items, onOpenChanges }: ConversationProps) {
  if (items.length === 0) {
    return (
      <div className="conversation-empty">
        <div className="conversation-empty__glyph" aria-hidden="true">
          <ChevronRight size={18} />
          <span>_</span>
        </div>
        <h1>What would you like to build?</h1>
        <p>Describe a task, ask about your code, or let Codex make a change.</p>
      </div>
    );
  }

  const previewCount = Math.max(0, items.length - FULL_RENDER_ITEM_WINDOW);
  return (
    <div className="conversation-list" aria-live="polite">
      {items.slice(0, previewCount).map((item) => (
        <DeferredConversationItem item={item} key={item.id} />
      ))}
      {items.slice(previewCount).map((item) => (
        <ConversationItem item={item} key={item.id} onOpenChanges={onOpenChanges} />
      ))}
    </div>
  );
}

function DeferredConversationItem({ item }: { item: VisibleItem }) {
  const { ref, expanded, expand } = useExpandNearViewport();
  if (expanded) return <ConversationItem item={item} />;
  return (
    <button
      className="conversation-preview"
      onClick={expand}
      ref={ref}
      title="Show the full item"
      type="button"
    >
      <span aria-hidden="true" className="conversation-preview__icon">
        <PreviewIcon item={item} />
      </span>
      <span className="conversation-preview__text">{previewText(item)}</span>
    </button>
  );
}

function useExpandNearViewport(): {
  ref: React.RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  expand: () => void;
} {
  const ref = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (expanded) return undefined;
    const element = ref.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setExpanded(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setExpanded(true);
    }, { rootMargin: "800px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);

  return { ref, expanded, expand: () => setExpanded(true) };
}

function PreviewIcon({ item }: { item: VisibleItem }) {
  return item.type === "command" ? <Terminal size={13} /> : <FileCode2 size={13} />;
}

function previewText(item: VisibleItem): string {
  if (item.type === "message") return firstLine(item.text);
  if (item.type === "command") return firstLine(item.command);
  if (item.type === "fileChange") {
    const paths = item.changes?.map((change) => change.path) ?? [item.path];
    return paths.slice(0, 2).join(", ") + (paths.length > 2 ? ` +${paths.length - 2}` : "");
  }
  return firstLine(item.text);
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 0 ? line : "(empty)";
}

function ConversationItem({ item, onOpenChanges }: { item: VisibleItem; onOpenChanges?: () => void }) {
  if (item.type === "message") {
    return (
      <article className={`message message--${item.role}`}>
        <div className="message__label">{item.role === "assistant" ? "Codex" : "You"}</div>
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          {item.streaming ? <span className="stream-cursor" aria-label="Streaming" /> : null}
        </div>
        {item.truncated ? <span className="truncation-badge">Output truncated</span> : null}
      </article>
    );
  }
  if (item.type === "command") {
    return (
      <article className="inline-activity">
        <div className="inline-activity__header">
          <Terminal size={14} />
          <code>{item.command}</code>
          <ActivityStatus status={item.status} />
        </div>
        {item.output ? <pre>{item.output}</pre> : null}
        {item.truncated ? <span className="truncation-badge">Output truncated</span> : null}
      </article>
    );
  }
  if (item.type === "fileChange") {
    const paths = item.changes?.map((change) => change.path) ?? [item.path];
    return (
      <button className="inline-activity inline-activity--changes" onClick={onOpenChanges} type="button">
        <div className="inline-activity__header">
          <FileCode2 size={14} />
          <code>{paths.slice(0, 2).join(", ")}{paths.length > 2 ? ` +${paths.length - 2}` : ""}</code>
          <ActivityStatus status={item.status} />
        </div>
        <span className="inline-activity__action">Inspect changes <ChevronRight size={13} /></span>
      </button>
    );
  }
  return (
    <div className={`status-note status-note--${item.tone ?? "neutral"}`}>
      {item.text}
      {item.truncated ? <span className="truncation-badge">Summary truncated</span> : null}
    </div>
  );
}

function ActivityStatus({ status }: { status: "running" | "completed" | "failed" }) {
  return status === "completed" ? (
    <CheckCircle2 className="activity-complete" size={13} aria-label="Completed" />
  ) : (
    <span className={`activity-state activity-state--${status}`}>{status}</span>
  );
}
