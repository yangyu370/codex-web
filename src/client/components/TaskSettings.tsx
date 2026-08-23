import { ScanSearch } from "lucide-react";

interface TaskSettingsProps {
  disabled?: boolean;
  reviewEnabled?: boolean;
  reviewRunning?: boolean;
  reviewDisabledReason?: string;
  onReview: () => void;
}

export function TaskSettings({
  disabled = false,
  reviewEnabled = false,
  reviewRunning = false,
  reviewDisabledReason,
  onReview,
}: TaskSettingsProps) {
  const reviewDisabled = disabled || reviewRunning || !reviewEnabled;
  const reviewTitle = reviewDisabledReason
    ?? (reviewRunning ? "Review is already running" : !reviewEnabled ? "Open an idle task to review changes" : undefined);

  return (
    <div className="task-settings" aria-label="Task settings">
      <div className="task-settings__controls" />
      <button
        className="review-button"
        disabled={reviewDisabled}
        onClick={onReview}
        title={reviewDisabled ? reviewTitle : "Review uncommitted changes inline"}
        type="button"
      >
        <ScanSearch size={14} />
        {reviewRunning ? "Reviewing…" : "Review changes"}
      </button>
    </div>
  );
}
