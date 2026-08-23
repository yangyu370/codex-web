import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronDown,
  CircleQuestionMark,
  Eye,
  FolderCog,
  Gauge,
  ShieldAlert,
} from "lucide-react";

import type {
  PermissionProfileSummary,
  ReasoningEffortOption,
} from "../../shared/protocol";

interface ComposerControlsProps {
  efforts: ReasoningEffortOption[];
  effort?: string;
  permissionProfiles: PermissionProfileSummary[];
  permissionProfile?: string;
  disabled?: boolean;
  pending?: "effort" | "permissionProfile";
  running?: boolean;
  onSettingsChange: (change: { effort?: string; permissionProfile?: string }) => void;
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

const runningSuffix = " · Applies from the next turn";

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

  return <Icon aria-hidden="true" size={16} strokeWidth={1.7} />;
}

function effortLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function useMenuDismiss(
  open: boolean,
  close: () => void,
): { triggerRef: React.RefObject<HTMLButtonElement | null>; menuRef: React.RefObject<HTMLDivElement | null> } {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };

    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
    };
  }, [open, close]);

  return { triggerRef, menuRef };
}

export function ComposerControls({
  efforts,
  effort,
  permissionProfiles,
  permissionProfile,
  disabled = false,
  pending,
  running = false,
  onSettingsChange,
}: ComposerControlsProps) {
  const [openMenu, setOpenMenu] = useState<"effort" | "permission" | null>(null);
  const [menuLayout, setMenuLayout] = useState<CSSProperties>();

  // The composer sits at the bottom of the viewport, so both menus open upward
  // and are clamped against the measured chip position to stay on screen.
  const openMenuAt = (menu: "effort" | "permission", trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(360, window.innerWidth - margin * 2);
    const viewportLeftBound = margin;
    const viewportRightBound = window.innerWidth - margin - width;
    const absoluteLeft = Math.min(rect.left, viewportRightBound);
    setMenuLayout({
      left: Math.max(absoluteLeft, viewportLeftBound) - rect.left,
      maxHeight: Math.max(160, Math.round(rect.top - margin * 2)),
      width,
    });
    setOpenMenu(menu);
  };

  const effortMenuId = useId();
  const effortOptionRefs = useRef(new Map<string, HTMLButtonElement>());
  const effortMenuOpen = openMenu === "effort";
  const effortNativeDisabled = disabled || efforts.length === 0;
  const effortPending = pending === "effort";
  const effortUnavailable = effortNativeDisabled || effortPending;

  const permissionMenuId = useId();
  const permissionHeadingId = useId();
  const permissionActiveModeId = useId();
  const permissionOptionRefs = useRef(new Map<string, HTMLButtonElement>());
  const permissionMenuOpen = openMenu === "permission";
  const permissionNativeDisabled = disabled || permissionProfiles.length === 0;
  const permissionPending = pending === "permissionProfile";
  const permissionUnavailable = permissionNativeDisabled || permissionPending;

  const closeEffortMenu = () => setOpenMenu((current) => current === "effort" ? null : current);
  const closePermissionMenu = () => setOpenMenu((current) => current === "permission" ? null : current);
  const effortMenu = useMenuDismiss(effortMenuOpen, closeEffortMenu);
  const permissionMenu = useMenuDismiss(permissionMenuOpen, closePermissionMenu);

  const selectedEffortEntry = efforts.find((entry) => entry.id === effort);
  const effortTitle = (selectedEffortEntry?.description ?? "Choose how hard Codex thinks about this task")
    + (running ? runningSuffix : "");

  const selectedPermission = permissionProfiles.find((entry) => entry.id === permissionProfile);
  const selectedPermissionPresentation = selectedPermission
    ? permissionPresentation(selectedPermission)
    : permissionProfile
      ? { label: permissionProfile }
      : undefined;
  const permissionTitle = (selectedPermissionPresentation?.description
    ?? selectedPermissionPresentation?.label
    ?? "Select a permission profile")
    + (running ? runningSuffix : "");

  useEffect(() => {
    if (openMenu && (openMenu === "effort" ? effortUnavailable : permissionUnavailable)) {
      setOpenMenu(null);
    }
  }, [openMenu, effortUnavailable, permissionUnavailable]);

  useEffect(() => {
    if (!effortMenuOpen) {
      effortOptionRefs.current.clear();
      return;
    }
    effortOptionRefs.current.get(effort ?? "")?.focus();
  }, [effortMenuOpen]);

  useEffect(() => {
    if (!permissionMenuOpen) {
      permissionOptionRefs.current.clear();
      return;
    }
    const initialProfile = permissionProfiles.find((profile) => (
      profile.id === permissionProfile && profile.allowed
    )) ?? permissionProfiles.find((profile) => profile.allowed);
    permissionOptionRefs.current.get(initialProfile?.id ?? "")?.focus();
  }, [permissionMenuOpen]);

  const selectEffort = (id: string) => {
    if (effortUnavailable) return;
    onSettingsChange({ effort: id });
    setOpenMenu(null);
    effortMenu.triggerRef.current?.focus();
  };

  const selectPermission = (profile: PermissionProfileSummary) => {
    if (permissionUnavailable || !profile.allowed) return;
    onSettingsChange({ permissionProfile: profile.id });
    setOpenMenu(null);
    permissionMenu.triggerRef.current?.focus();
  };

  return (
    <div className="composer-controls" aria-label="Task controls">
      <div className="composer-menu-anchor">
        <button
          aria-controls={effortMenuOpen ? effortMenuId : undefined}
          aria-expanded={effortMenuOpen}
          aria-haspopup="dialog"
          aria-label="Reasoning effort"
          className="composer-chip"
          data-pending={effortPending || undefined}
          disabled={effortNativeDisabled}
          onClick={(event) => {
            if (effortUnavailable) return;
            if (effortMenuOpen) setOpenMenu(null);
            else openMenuAt("effort", event.currentTarget);
          }}
          ref={effortMenu.triggerRef}
          title={effortTitle}
          type="button"
        >
          <Gauge aria-hidden="true" size={14} />
          <span className="composer-chip__label">
            {effort ? effortLabel(effort) : "Effort"}
          </span>
          <ChevronDown aria-hidden="true" className="composer-chip__chevron" size={13} />
        </button>
        {effortMenuOpen ? (
          <div
            aria-label="Reasoning effort"
            className="composer-menu composer-menu--effort"
            id={effortMenuId}
            style={menuLayout}
            ref={effortMenu.menuRef}
            role="dialog"
          >
            <div className="composer-menu__options">
              {efforts.map((entry) => {
                const selected = entry.id === effort;
                return (
                  <button
                    aria-label={effortLabel(entry.id)}
                    aria-pressed={selected}
                    className="composer-menu__option composer-menu__option--effort"
                    disabled={effortUnavailable}
                    key={entry.id}
                    onClick={() => selectEffort(entry.id)}
                    ref={(element) => {
                      if (element) effortOptionRefs.current.set(entry.id, element);
                      else effortOptionRefs.current.delete(entry.id);
                    }}
                    title={entry.description}
                    type="button"
                  >
                    <span className="composer-menu__option-label">{effortLabel(entry.id)}</span>
                    {selected ? (
                      <span aria-hidden="true" className="composer-menu__option-marker">
                        <Check size={15} strokeWidth={2.2} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <div className="composer-menu-anchor">
        <button
          aria-controls={permissionMenuOpen ? permissionMenuId : undefined}
          aria-describedby={permissionActiveModeId}
          aria-disabled={permissionPending || undefined}
          aria-expanded={permissionMenuOpen}
          aria-haspopup="dialog"
          aria-label="Permissions"
          className="composer-chip"
          data-pending={permissionPending || undefined}
          disabled={permissionNativeDisabled}
          onClick={(event) => {
            if (permissionUnavailable) return;
            if (permissionMenuOpen) setOpenMenu(null);
            else openMenuAt("permission", event.currentTarget);
          }}
          ref={permissionMenu.triggerRef}
          title={permissionTitle}
          type="button"
        >
          <span className="composer-chip__icon">
            <PermissionProfileIcon profileId={permissionProfile ?? ""} />
          </span>
          <span className="composer-chip__label" id={permissionActiveModeId}>
            {selectedPermissionPresentation?.label ?? "Select profile"}
          </span>
          <ChevronDown aria-hidden="true" className="composer-chip__chevron" size={13} />
        </button>
        {permissionMenuOpen ? (
          <div
            aria-labelledby={permissionHeadingId}
            className="composer-menu composer-menu--permission"
            id={permissionMenuId}
            style={menuLayout}
            ref={permissionMenu.menuRef}
            role="dialog"
          >
            <h2 className="composer-menu__heading" id={permissionHeadingId}>How should Codex run?</h2>
            <div className="composer-menu__options">
              {permissionProfiles.map((profile, index) => {
                const presentation = permissionPresentation(profile);
                const descriptionId = `${permissionMenuId}-description-${index}`;
                const selected = profile.id === permissionProfile;
                return (
                  <button
                    aria-describedby={presentation.description ? descriptionId : undefined}
                    aria-label={presentation.label}
                    aria-pressed={selected}
                    className="composer-menu__option"
                    data-profile-id={profile.id}
                    disabled={permissionUnavailable || !profile.allowed}
                    key={profile.id}
                    onClick={() => selectPermission(profile)}
                    ref={(element) => {
                      if (element) permissionOptionRefs.current.set(profile.id, element);
                      else permissionOptionRefs.current.delete(profile.id);
                    }}
                    title={profile.description}
                    type="button"
                  >
                    <span className="composer-menu__option-icon">
                      <PermissionProfileIcon profileId={profile.id} />
                    </span>
                    <span className="composer-menu__option-copy">
                      <span className="composer-menu__option-title">{presentation.label}</span>
                      {presentation.description ? (
                        <span className="composer-menu__option-description" id={descriptionId}>
                          {presentation.description}
                        </span>
                      ) : null}
                    </span>
                    {selected ? (
                      <span aria-hidden="true" className="composer-menu__option-marker">
                        <Check size={15} strokeWidth={2.2} />
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
  );
}
