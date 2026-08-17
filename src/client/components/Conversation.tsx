import { CheckCircle2, ChevronRight, FileCode2, Terminal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { VisibleItem } from "../../shared/protocol";

interface ConversationProps {
  items: VisibleItem[];
}

export function Conversation({ items }: ConversationProps) {
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

  return (
    <div className="conversation-list" aria-live="polite">
      {items.map((item) => (
        <ConversationItem item={item} key={item.id} />
      ))}
    </div>
  );
}

function ConversationItem({ item }: { item: VisibleItem }) {
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
    return (
      <article className="inline-activity">
        <div className="inline-activity__header">
          <FileCode2 size={14} />
          <code>{item.path}</code>
          <ActivityStatus status={item.status} />
        </div>
      </article>
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
