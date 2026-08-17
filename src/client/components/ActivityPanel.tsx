import {
  Check,
  ChevronDown,
  CircleEllipsis,
  FileDiff,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";

import type { PendingApproval, VisibleItem } from "../../shared/protocol";

type ActivityItem = Exclude<VisibleItem, { type: "message" }>;

interface ActivityPanelProps {
  items: VisibleItem[];
  approvals: PendingApproval[];
  onResolveApproval?: (id: string, decision: string) => void;
}

export function ActivityPanel({
  items,
  approvals,
  onResolveApproval,
}: ActivityPanelProps) {
  const activities = items.filter(isActivityItem);
  return (
    <aside aria-label="Activity" className="activity-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-heading__eyebrow">Live</span>
          <h2>Activity</h2>
        </div>
        <CircleEllipsis size={17} />
      </div>
      {approvals.length > 0 ? (
        <section className="approval-stack" aria-label="Pending approvals">
          {approvals.map((approval) => (
            <ApprovalCard
              approval={approval}
              key={approval.id}
              onResolve={onResolveApproval}
            />
          ))}
        </section>
      ) : null}
      <div className="activity-feed">
        {activities.length === 0 ? (
          <div className="activity-empty">
            <span className="activity-empty__icon"><CircleEllipsis size={16} /></span>
            <strong>Waiting for activity</strong>
            <p>Commands, file changes, and status updates appear here.</p>
          </div>
        ) : (
          activities.map((item) => <ActivityRow item={item} key={item.id} />)
        )}
      </div>
    </aside>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve?: (id: string, decision: string) => void;
}) {
  const accept = approval.availableDecisions.find((decision) =>
    ["accept", "acceptForSession", "grantTurn", "grantSession"].includes(decision),
  );
  const decline = approval.availableDecisions.find((decision) =>
    ["decline", "cancel"].includes(decision),
  );
  return (
    <article className="approval-card">
      <div className="approval-card__title">
        <span className="approval-card__icon"><ShieldAlert size={15} /></span>
        <div>
          <strong>{approval.kind === "command" ? "Approve command" : "Approve file changes"}</strong>
          <span>Codex needs your permission</span>
        </div>
      </div>
      <p>{approval.reason ?? approval.command ?? "Review this action before continuing."}</p>
      {approval.command ? <code className="approval-card__command">{approval.command}</code> : null}
      <div className="approval-card__actions">
        {decline ? (
          <button onClick={() => onResolve?.(approval.id, decline)} type="button">
            <X size={13} /> Decline
          </button>
        ) : null}
        {accept ? (
          <button
            className="button-primary"
            onClick={() => onResolve?.(approval.id, accept)}
            type="button"
          >
            <Check size={13} /> Approve
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  if (item.type === "status") {
    return <div className="activity-row activity-row--status">{item.text}</div>;
  }
  const file = item.type === "fileChange";
  return (
    <details className="activity-row" open={item.status === "running"}>
      <summary>
        <span className="activity-row__icon">
          {file ? <FileDiff size={14} /> : <TerminalSquare size={14} />}
        </span>
        <span className="activity-row__copy">
          <strong>{file ? item.path : item.command}</strong>
          <small>{item.status}</small>
        </span>
        <ChevronDown size={13} />
      </summary>
      {!file && item.output ? <pre>{item.output}</pre> : null}
      {file && item.diff ? <pre className="diff-output">{item.diff}</pre> : null}
      {item.truncated ? <span className="truncation-badge">Truncated</span> : null}
    </details>
  );
}

function isActivityItem(item: VisibleItem): item is ActivityItem {
  return item.type !== "message";
}
