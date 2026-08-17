import { CircleStop, Cloud, Laptop, LoaderCircle, OctagonAlert } from "lucide-react";

import type { BrowserSnapshot } from "../../shared/protocol";

interface AppHeaderProps {
  service: BrowserSnapshot["service"];
  activeTurn: BrowserSnapshot["activeTurn"];
  threadTitle?: string;
  onInterrupt?: () => void;
}

export function AppHeader({
  service,
  activeTurn,
  threadTitle,
  onInterrupt,
}: AppHeaderProps) {
  const ready = service.status === "ready";
  return (
    <header className="app-header">
      <div className="app-header__title">
        <span className="app-header__eyebrow">Codex</span>
        <span className="app-header__divider" aria-hidden="true" />
        <strong>{threadTitle ?? "New task"}</strong>
      </div>
      <div className="app-header__status">
        <span className={`status-pill status-pill--${service.status}`}>
          {ready ? (
            <span className="status-dot" aria-hidden="true" />
          ) : service.status === "unavailable" ? (
            <OctagonAlert size={13} />
          ) : (
            <LoaderCircle className="spin" size={13} />
          )}
          {service.status}
        </span>
        <span className="host-meta" title={`Native ${service.platform}`}>
          {service.platform === "macos" ? <Laptop size={13} /> : <Cloud size={13} />}
          {service.codexVersion ?? service.platform}
        </span>
        {activeTurn?.status === "inProgress" ? (
          <button className="interrupt-button" onClick={onInterrupt} type="button">
            <CircleStop size={14} />
            Stop
          </button>
        ) : null}
      </div>
    </header>
  );
}

