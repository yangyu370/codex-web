import { BrainCircuit, ScanSearch, ShieldCheck } from "lucide-react";

import type {
  ModelSummary,
  PermissionProfileSummary,
} from "../../shared/protocol";

interface TaskSettingsProps {
  models: ModelSummary[];
  permissionProfiles: PermissionProfileSummary[];
  model: string;
  effort?: string;
  permissionProfile?: string;
  editableModel?: boolean;
  showModel?: boolean;
  disabled?: boolean;
  pending?: "model" | "effort" | "permissionProfile";
  running?: boolean;
  reviewEnabled?: boolean;
  reviewRunning?: boolean;
  reviewDisabledReason?: string;
  onModelChange?: (model: string, effort?: string) => void;
  onSettingsChange: (change: { effort?: string; permissionProfile?: string }) => void;
  onReview: () => void;
}

export function TaskSettings({
  models,
  permissionProfiles,
  model,
  effort,
  permissionProfile,
  editableModel = false,
  showModel = true,
  disabled = false,
  pending,
  running = false,
  reviewEnabled = false,
  reviewRunning = false,
  reviewDisabledReason,
  onModelChange,
  onSettingsChange,
  onReview,
}: TaskSettingsProps) {
  const selectedModel = models.find((entry) => entry.id === model) ?? models[0];
  const catalogEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const efforts = effort && !catalogEfforts.some((entry) => entry.id === effort)
    ? [...catalogEfforts, { id: effort, description: "Current task value" }]
    : catalogEfforts;
  const selectedEffort = efforts.some((entry) => entry.id === effort)
    ? effort
    : selectedModel?.defaultReasoningEffort ?? efforts[0]?.id ?? "";
  const reviewDisabled = disabled || reviewRunning || !reviewEnabled;
  const reviewTitle = reviewDisabledReason
    ?? (reviewRunning ? "Review is already running" : !reviewEnabled ? "Open an idle task to review changes" : undefined);

  return (
    <div className="task-settings" aria-label="Task settings">
      <div className="task-settings__controls">
        {showModel ? <label className="task-setting" data-pending={pending === "model" || undefined}>
          <span><BrainCircuit size={13} /> Model</span>
          <select
            aria-label="Task model"
            disabled={disabled || !editableModel}
            onChange={(event) => {
              const nextModel = models.find((entry) => entry.id === event.target.value);
              const supported = nextModel?.supportedReasoningEfforts ?? [];
              const nextEffort = supported.some((entry) => entry.id === effort)
                ? effort
                : nextModel?.defaultReasoningEffort ?? supported[0]?.id;
              onModelChange?.(event.target.value, nextEffort);
            }}
            title={editableModel ? "Select the model for this task" : "The loaded task controls its model"}
            value={model}
          >
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.displayName}</option>
            ))}
          </select>
        </label> : null}
        <label className="task-setting" data-pending={pending === "effort" || undefined}>
          <span>Effort {running ? <em>Next turn</em> : null}</span>
          <select
            aria-label="Reasoning effort"
            disabled={disabled || efforts.length === 0}
            onChange={(event) => onSettingsChange({ effort: event.target.value })}
            value={selectedEffort}
          >
            {efforts.map((entry) => (
              <option key={entry.id} title={entry.description} value={entry.id}>
                {entry.id}{entry.description ? ` · ${entry.description}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="task-setting" data-pending={pending === "permissionProfile" || undefined}>
          <span><ShieldCheck size={13} /> Permissions {running ? <em>Next turn</em> : null}</span>
          <select
            aria-label="Permission profile"
            disabled={disabled || permissionProfiles.length === 0}
            onChange={(event) => onSettingsChange({ permissionProfile: event.target.value })}
            value={permissionProfile ?? ""}
          >
            {!permissionProfile ? <option value="">Select profile</option> : null}
            {permissionProfiles.map((profile) => (
              <option
                disabled={!profile.allowed}
                key={profile.id}
                title={profile.description}
                value={profile.id}
              >
                {profile.id}{profile.description ? ` · ${profile.description}` : ""}
              </option>
            ))}
          </select>
        </label>
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
