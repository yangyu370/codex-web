import { BrainCircuit, ScanSearch } from "lucide-react";

import type { ModelSummary } from "../../shared/protocol";

interface TaskSettingsProps {
  models: ModelSummary[];
  model: string;
  editableModel?: boolean;
  showModel?: boolean;
  disabled?: boolean;
  reviewEnabled?: boolean;
  reviewRunning?: boolean;
  reviewDisabledReason?: string;
  onModelChange?: (model: string) => void;
  onReview: () => void;
}

export function TaskSettings({
  models,
  model,
  editableModel = false,
  showModel = true,
  disabled = false,
  reviewEnabled = false,
  reviewRunning = false,
  reviewDisabledReason,
  onModelChange,
  onReview,
}: TaskSettingsProps) {
  const reviewDisabled = disabled || reviewRunning || !reviewEnabled;
  const reviewTitle = reviewDisabledReason
    ?? (reviewRunning ? "Review is already running" : !reviewEnabled ? "Open an idle task to review changes" : undefined);

  return (
    <div className="task-settings" aria-label="Task settings">
      <div className="task-settings__controls">
        {showModel ? <label className="task-setting">
          <span><BrainCircuit size={13} /> Model</span>
          <select
            aria-label="Task model"
            disabled={disabled || !editableModel}
            onChange={(event) => onModelChange?.(event.target.value)}
            title={editableModel ? "Select the model for this task" : "The loaded task controls its model"}
            value={model}
          >
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.displayName}</option>
            ))}
          </select>
        </label> : null}
      </div>
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
