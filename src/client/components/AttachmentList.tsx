import { FileImage, FileText, LoaderCircle, TriangleAlert, X } from "lucide-react";

import type { DraftAttachment } from "../attachments";

interface AttachmentListProps {
  attachments: DraftAttachment[];
  onRemove: (attachment: DraftAttachment) => void;
}

export function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
  if (attachments.length === 0) return null;
  return (
    <div aria-label="Attached files" className="attachment-list">
      {attachments.map((attachment) => (
        <div className="attachment-row" data-status={attachment.status} key={attachment.localId}>
          <span className="attachment-row__icon" aria-hidden="true">
            {attachment.status === "uploading" ? (
              <LoaderCircle className="spin" size={14} />
            ) : attachment.status === "failed" ? (
              <TriangleAlert size={14} />
            ) : attachment.remote?.kind === "image" ? (
              <FileImage size={14} />
            ) : (
              <FileText size={14} />
            )}
          </span>
          <span className="attachment-row__body">
            <strong>{attachment.remote?.name ?? attachment.file.name}</strong>
            <small>
              {attachment.status === "uploading"
                ? `Uploading ${Math.round(attachment.progress * 100)}%`
                : attachment.status === "failed"
                  ? attachment.error ?? "Upload failed"
                  : `Ready · ${formatBytes(attachment.remote?.size ?? attachment.file.size)}`}
            </small>
            {attachment.status === "uploading" ? (
              <span className="attachment-progress" aria-hidden="true">
                <span style={{ width: `${Math.round(attachment.progress * 100)}%` }} />
              </span>
            ) : null}
          </span>
          <button
            aria-label={`Remove ${attachment.remote?.name ?? attachment.file.name}`}
            className="attachment-row__remove"
            onClick={() => onRemove(attachment)}
            type="button"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
