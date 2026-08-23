import { useEffect, useId, useRef, useState } from "react";
import {
  BrainCircuit,
  Check,
  CircleQuestionMark,
  Eye,
  FolderCog,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

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

function PermissionProfileIcon({ profileId }: { profileId: string }) {
  const Icon = profileId === ":read-only"
    ? Eye
    : profileId === ":workspace"
      ? FolderCog
      : profileId === ":danger-full-access"
        ? ShieldAlert
        : CircleQuestionMark;

  return <Icon aria-hidden="true" size={17} strokeWidth={1.7} />;
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
  const permissionOptionRefs = useRef(new Map<string, HTMLButtonElement>());
  const permissionMenuId = useId();
  const permissionHeadingId = useId();
  const permissionActiveModeId = useId();
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
  const permissionMenuNativeDisabled = disabled || permissionProfiles.length === 0;
  const permissionMenuPending = pending === "permissionProfile";
  const permissionMenuUnavailable = permissionMenuNativeDisabled || permissionMenuPending;

  useEffect(() => {
    if (permissionMenuOpen && permissionMenuUnavailable) setPermissionMenuOpen(false);
  }, [permissionMenuOpen, permissionMenuUnavailable]);

  useEffect(() => {
    if (!permissionMenuOpen) return;

    const initialProfile = permissionProfiles.find((profile) => (
      profile.id === permissionProfile && profile.allowed
    )) ?? permissionProfiles.find((profile) => profile.allowed);
    permissionOptionRefs.current.get(initialProfile?.id ?? "")?.focus();

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
    if (permissionMenuUnavailable || !profile.allowed) return;
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
            aria-controls={permissionMenuId}
            aria-describedby={permissionActiveModeId}
            aria-disabled={permissionMenuPending || undefined}
            aria-expanded={permissionMenuOpen}
            aria-haspopup="dialog"
            aria-label="Permissions"
            className="permission-profile-trigger"
            disabled={permissionMenuNativeDisabled}
            onClick={() => {
              if (permissionMenuUnavailable) return;
              setPermissionMenuOpen((open) => !open);
            }}
            ref={permissionTriggerRef}
            title={selectedPermissionPresentation?.label ?? "Select a permission profile"}
            type="button"
          >
            <span className="permission-profile-trigger__content" id={permissionActiveModeId}>
              {selectedPermissionPresentation?.label ?? "Select profile"}
            </span>
          </button>
          {permissionMenuOpen ? (
            <div
              aria-labelledby={permissionHeadingId}
              className="permission-profile-menu"
              id={permissionMenuId}
              ref={permissionDialogRef}
              role="dialog"
            >
              <h2 className="permission-profile-menu__heading" id={permissionHeadingId}>How should Codex run?</h2>
              <div className="permission-profile-options">
                {permissionProfiles.map((profile, index) => {
                  const presentation = permissionPresentation(profile);
                  const descriptionId = `${permissionMenuId}-description-${index}`;
                  const selected = profile.id === permissionProfile;
                  return (
                    <button
                      aria-describedby={presentation.description ? descriptionId : undefined}
                      aria-label={presentation.label}
                      aria-pressed={selected}
                      className="permission-profile-option"
                      data-profile-id={profile.id}
                      disabled={permissionMenuUnavailable || !profile.allowed}
                      key={profile.id}
                      onClick={() => selectPermission(profile)}
                      ref={(element) => {
                        if (element) permissionOptionRefs.current.set(profile.id, element);
                        else permissionOptionRefs.current.delete(profile.id);
                      }}
                      title={profile.description}
                      type="button"
                    >
                      <span className="permission-profile-option__icon">
                        <PermissionProfileIcon profileId={profile.id} />
                      </span>
                      <span className="permission-profile-option__copy">
                        <span className="permission-profile-option__title">{presentation.label}</span>
                        {presentation.description ? (
                          <span className="permission-profile-option__description" id={descriptionId}>
                            {presentation.description}
                          </span>
                        ) : null}
                      </span>
                      {selected ? (
                        <span aria-hidden="true" className="permission-profile-option__selected-marker">
                          <Check size={16} strokeWidth={2.2} />
                        </span>
                      ) : null}
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
