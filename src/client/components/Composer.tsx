import { ArrowUp, FolderGit2, FolderOpen, Paperclip, Square } from "lucide-react";
import { useRef } from "react";

import type { ModelSummary } from "../../shared/protocol";
import type { DraftAttachment } from "../attachments";
import { AttachmentList } from "./AttachmentList";

interface ComposerProps {
  value: string;
  cwd: string;
  model: string;
  models: ModelSummary[];
  recentDirectories?: string[];
  running: boolean;
  disabled?: boolean;
  attachments?: DraftAttachment[];
  attachmentBlocked?: boolean;
  onValueChange: (value: string) => void;
  onCwdChange: (cwd: string) => void;
  onBrowseDirectory?: () => void;
  onModelChange: (model: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onFilesSelected?: (files: File[]) => void;
  onRemoveAttachment?: (attachment: DraftAttachment) => void;
}

export function Composer({
  value,
  cwd,
  model,
  models,
  recentDirectories = [],
  running,
  disabled,
  attachments = [],
  attachmentBlocked = false,
  onValueChange,
  onCwdChange,
  onBrowseDirectory,
  onModelChange,
  onSend,
  onInterrupt,
  onFilesSelected,
  onRemoveAttachment,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hasReadyAttachment = attachments.some((attachment) => attachment.status === "ready");
  const canSend = !disabled && !attachmentBlocked &&
    (value.trim().length > 0 || hasReadyAttachment) && cwd.trim().length > 0 && Boolean(model);
  return (
    <div className="composer-wrap">
      <div className="composer">
        <AttachmentList
          attachments={attachments}
          onRemove={(attachment) => onRemoveAttachment?.(attachment)}
        />
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
          <input
            aria-label="Choose attachment files"
            className="sr-only"
            disabled={disabled || running || !cwd.trim()}
            multiple
            onChange={(event) => {
              onFilesSelected?.(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
            ref={fileInput}
            type="file"
          />
          <button
            aria-label="Attach context"
            className="icon-button"
            disabled={disabled || running || !cwd.trim()}
            onClick={() => fileInput.current?.click()}
            title={cwd.trim() ? "Attach files from this device" : "Choose a working directory first"}
            type="button"
          >
            <Paperclip size={15} />
          </button>
          <div className="composer-control composer-control--cwd">
            <FolderGit2 size={14} />
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
            <button
              aria-label="Browse server directories"
              className="composer-control__browse"
              disabled={disabled || !onBrowseDirectory}
              onClick={onBrowseDirectory}
              title="Choose a folder on the Codex host"
              type="button"
            >
              <FolderOpen size={14} />
            </button>
          </div>
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
