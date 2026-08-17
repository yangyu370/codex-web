import { ArrowUp, FolderGit2, Paperclip, Square } from "lucide-react";
import { useRef } from "react";

import type { ModelSummary } from "../../shared/protocol";

interface ComposerProps {
  value: string;
  cwd: string;
  model: string;
  models: ModelSummary[];
  recentDirectories?: string[];
  running: boolean;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  onCwdChange: (cwd: string) => void;
  onModelChange: (model: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
}

export function Composer({
  value,
  cwd,
  model,
  models,
  recentDirectories = [],
  running,
  disabled,
  onValueChange,
  onCwdChange,
  onModelChange,
  onSend,
  onInterrupt,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const canSend = !disabled && value.trim().length > 0 && cwd.trim().length > 0 && model;
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          aria-label="Message Codex"
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && canSend && !running) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Ask Codex to build, explain, or fix something…"
          ref={textarea}
          rows={2}
          value={value}
        />
        <div className="composer__toolbar">
          <button aria-label="Attach context" className="icon-button" type="button">
            <Paperclip size={15} />
          </button>
          <label className="composer-control composer-control--cwd">
            <FolderGit2 size={14} />
            <span className="sr-only">Working directory</span>
            <input
              aria-label="Working directory"
              list="recent-directories"
              onChange={(event) => onCwdChange(event.target.value)}
              placeholder="Working directory"
              value={cwd}
            />
            <datalist id="recent-directories">
              {recentDirectories.map((directory) => (
                <option key={directory} value={directory} />
              ))}
            </datalist>
          </label>
          <label className="composer-control">
            <span className="sr-only">Model</span>
            <select
              aria-label="Model"
              onChange={(event) => onModelChange(event.target.value)}
              value={model}
            >
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>
          {running ? (
            <button aria-label="Stop" className="send-button send-button--stop" onClick={onInterrupt} type="button">
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button aria-label="Send" className="send-button" disabled={!canSend} onClick={onSend} type="button">
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
    </div>
  );
}
