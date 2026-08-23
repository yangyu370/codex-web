import { useEffect, useRef, useState } from "react";
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

interface PermissionPresentation {
  label: string;
  description?: string;
}

const knownPermissionPresentations: Record<string, PermissionPresentation> = {
  ":read-only": {
    label: "Ask for approval",
    description: "Ask before editing files or using the internet.",
  },
  ":workspace": {
    label: "Approve when needed",
    description: "Ask only when Codex detects a risky operation.",
  },
  ":danger-full-access": {
    label: "Full access",
    description: "Use the internet and any file on this computer without restrictions.",
  },
};

function permissionPresentation(profile: PermissionProfileSummary): PermissionPresentation {
  const known = knownPermissionPresentations[profile.id];
  return {
    label: known?.label ?? profile.id,
    description: !profile.allowed && profile.description
      ? profile.description
      : known?.description ?? profile.description,
  };
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
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const permissionTriggerRef = useRef<HTMLButtonElement>(null);
  const permissionDialogRef = useRef<HTMLDivElement>(null);
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

  const selectedPermission = permissionProfiles.find((entry) => entry.id === permissionProfile);
  const selectedPermissionPresentation = selectedPermission
    ? permissionPresentation(selectedPermission)
    : permissionProfile
      ? { label: permissionProfile }
      : undefined;
  const permissionMenuDisabled = disabled || pending === "permissionProfile" || permissionProfiles.length === 0;

  useEffect(() => {
    if (!permissionMenuOpen) return;

    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPermissionMenuOpen(false);
      permissionTriggerRef.current?.focus();
    };
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (permissionTriggerRef.current?.contains(target) || permissionDialogRef.current?.contains(target)) return;
      setPermissionMenuOpen(false);
    };

    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
    };
  }, [permissionMenuOpen]);

  const selectPermission = (profile: PermissionProfileSummary) => {
    if (!profile.allowed) return;
    onSettingsChange({ permissionProfile: profile.id });
    setPermissionMenuOpen(false);
    permissionTriggerRef.current?.focus();
  };

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
        <div className="task-setting" data-pending={pending === "permissionProfile" || undefined}>
          <span><ShieldCheck size={13} /> Permissions {running ? <em>Next turn</em> : null}</span>
          <button
            aria-controls="permission-profile-menu"
            aria-expanded={permissionMenuOpen}
            aria-haspopup="dialog"
            aria-label="Permissions"
            className="permission-profile-trigger"
            disabled={permissionMenuDisabled}
            onClick={() => setPermissionMenuOpen((open) => !open)}
            ref={permissionTriggerRef}
            title={selectedPermissionPresentation?.label ?? "Select a permission profile"}
            type="button"
          >
            <span>{selectedPermissionPresentation?.label ?? "Select profile"}</span>
          </button>
          {permissionMenuOpen ? (
            <div
              aria-labelledby="permission-profile-menu-title"
              className="permission-profile-menu"
              id="permission-profile-menu"
              ref={permissionDialogRef}
              role="dialog"
            >
              <h2 id="permission-profile-menu-title">How should Codex run?</h2>
              <div className="permission-profile-options">
                {permissionProfiles.map((profile, index) => {
                  const presentation = permissionPresentation(profile);
                  const descriptionId = `permission-profile-description-${index}`;
                  return (
                    <button
                      aria-describedby={presentation.description ? descriptionId : undefined}
                      aria-label={presentation.label}
                      aria-pressed={profile.id === permissionProfile}
                      className="permission-profile-option"
                      data-profile-id={profile.id}
                      disabled={!profile.allowed}
                      key={profile.id}
                      onClick={() => selectPermission(profile)}
                      title={profile.description}
                      type="button"
                    >
                      <span>{presentation.label}</span>
                      {presentation.description ? <span id={descriptionId}>{presentation.description}</span> : null}
                      {profile.id === permissionProfile ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
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
