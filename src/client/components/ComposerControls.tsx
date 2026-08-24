import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BrainCircuit,
  Check,
  ChevronDown,
  CircleQuestionMark,
  Eye,
  FolderCog,
  Gauge,
  ShieldAlert,
} from "lucide-react";

import type {
  ModelSummary,
  PermissionProfileSummary,
  ReasoningEffortOption,
} from "../../shared/protocol";

interface ComposerControlsProps {
  efforts: ReasoningEffortOption[];
  effort?: string;
  models: ModelSummary[];
  model?: string;
  permissionProfiles: PermissionProfileSummary[];
  permissionProfile?: string;
  disabled?: boolean;
  disabledReason?: string;
  pending?: "effort" | "permissionProfile";
  showModel?: boolean;
  running?: boolean;
  onModelChange: (model: string) => void;
  onSettingsChange: (change: { effort?: string; permissionProfile?: string }) => void;
}

type MenuKind = "model" | "effort" | "permission";

const menuWidths: Record<MenuKind, number> = {
  model: 264,
  effort: 168,
  permission: 360,
};

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
  models,
  model,
  permissionProfiles,
  permissionProfile,
  disabled = false,
  disabledReason,
  pending,
  showModel = true,
  running = false,
  onModelChange,
  onSettingsChange,
}: ComposerControlsProps) {
  const [openMenu, setOpenMenu] = useState<MenuKind | null>(null);
  const [menuLayout, setMenuLayout] = useState<CSSProperties>();

  // The composer sits at the bottom of the viewport, so every menu opens upward
  // and is clamped against the measured chip position to stay on screen.
  const openMenuAt = (menu: MenuKind, trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(menuWidths[menu], window.innerWidth - margin * 2);
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

  const modelMenuId = useId();
  const modelOptionRefs = useRef(new Map<string, HTMLButtonElement>());
  const modelMenuOpen = openMenu === "model";
  const modelNativeDisabled = disabled || models.length === 0;
  const selectedModel = models.find((entry) => entry.id === model);

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

  const closeMenu = (menu: MenuKind) => setOpenMenu((current) => current === menu ? null : current);
  const modelMenu = useMenuDismiss(modelMenuOpen, () => closeMenu("model"));
  const effortMenu = useMenuDismiss(effortMenuOpen, () => closeMenu("effort"));
  const permissionMenu = useMenuDismiss(permissionMenuOpen, () => closeMenu("permission"));

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
    if (!openMenu) return;
    if (openMenu === "effort" ? effortUnavailable : openMenu === "permission" ? permissionUnavailable : modelNativeDisabled) {
      setOpenMenu(null);
    }
  }, [openMenu, effortUnavailable, permissionUnavailable, modelNativeDisabled]);

  useEffect(() => {
    if (!modelMenuOpen) {
      modelOptionRefs.current.clear();
      return;
    }
    modelOptionRefs.current.get(model ?? "")?.focus();
  }, [modelMenuOpen]);

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

  const selectModel = (id: string) => {
    if (modelNativeDisabled || id === model) {
      setOpenMenu(null);
      modelMenu.triggerRef.current?.focus();
      return;
    }
    onModelChange(id);
    setOpenMenu(null);
    modelMenu.triggerRef.current?.focus();
  };

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
      {showModel ? (
        <Chip
          ariaControls={modelMenuOpen ? modelMenuId : undefined}
          ariaExpanded={modelMenuOpen}
          ariaLabel="Model"
          disabled={modelNativeDisabled}
          icon={<BrainCircuit aria-hidden="true" size={14} />}
          label={selectedModel?.displayName ?? "Model"}
          menuId={modelMenuId}
          onOpen={(trigger) => {
            if (modelNativeDisabled) return;
            if (modelMenuOpen) setOpenMenu(null);
            else openMenuAt("model", trigger);
          }}
          open={modelMenuOpen}
          title={disabled && disabledReason ? disabledReason : selectedModel?.description ?? selectedModel?.displayName ?? "Select the model for this task"}
          triggerRef={modelMenu.triggerRef}
        >
          <MenuShell
            ariaLabel="Model"
            id={modelMenuId}
            menuRef={modelMenu.menuRef}
            style={menuLayout}
          >
            <div className="composer-menu__options">
              {models.map((entry) => {
                const selected = entry.id === model;
                return (
                  <button
                    aria-label={entry.displayName}
                    aria-pressed={selected}
                    className="composer-menu__option composer-menu__option--simple"
                    disabled={modelNativeDisabled}
                    key={entry.id}
                    onClick={() => selectModel(entry.id)}
                    ref={(element) => {
                      if (element) modelOptionRefs.current.set(entry.id, element);
                      else modelOptionRefs.current.delete(entry.id);
                    }}
                    title={entry.description ?? entry.displayName}
                    type="button"
                  >
                    <span className="composer-menu__option-label">{entry.displayName}</span>
                    {selected ? (
                      <span aria-hidden="true" className="composer-menu__option-marker">
                        <Check size={15} strokeWidth={2.2} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </MenuShell>
        </Chip>
      ) : null}
      <Chip
        ariaControls={effortMenuOpen ? effortMenuId : undefined}
        ariaExpanded={effortMenuOpen}
        ariaLabel="Reasoning effort"
        dataPending={effortPending || undefined}
        disabled={effortNativeDisabled}
        icon={<Gauge aria-hidden="true" size={14} />}
        label={effort ? effortLabel(effort) : "Effort"}
        menuId={effortMenuId}
        onOpen={(trigger) => {
          if (effortUnavailable) return;
          if (effortMenuOpen) setOpenMenu(null);
          else openMenuAt("effort", trigger);
        }}
        open={effortMenuOpen}
        title={disabled && disabledReason ? disabledReason : effortTitle}
        triggerRef={effortMenu.triggerRef}
      >
        <MenuShell
          ariaLabel="Reasoning effort"
          id={effortMenuId}
          menuRef={effortMenu.menuRef}
          style={menuLayout}
        >
          <div className="composer-menu__options">
            {efforts.map((entry) => {
              const selected = entry.id === effort;
              return (
                <button
                  aria-label={effortLabel(entry.id)}
                  aria-pressed={selected}
                  className="composer-menu__option composer-menu__option--simple"
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
        </MenuShell>
      </Chip>
      <Chip
        ariaControls={permissionMenuOpen ? permissionMenuId : undefined}
        ariaDescribedBy={permissionActiveModeId}
        ariaDisabled={permissionPending || undefined}
        ariaExpanded={permissionMenuOpen}
        ariaLabel="Permissions"
        dataPending={permissionPending || undefined}
        disabled={permissionNativeDisabled}
        icon={<PermissionProfileIcon profileId={permissionProfile ?? ""} />}
        label={selectedPermissionPresentation?.label ?? "Select profile"}
        labelId={permissionActiveModeId}
        menuId={permissionMenuId}
        onOpen={(trigger) => {
          if (permissionUnavailable) return;
          if (permissionMenuOpen) setOpenMenu(null);
          else openMenuAt("permission", trigger);
        }}
        open={permissionMenuOpen}
        title={disabled && disabledReason ? disabledReason : permissionTitle}
        triggerRef={permissionMenu.triggerRef}
      >
        <MenuShell
          ariaLabelledBy={permissionHeadingId}
          id={permissionMenuId}
          menuRef={permissionMenu.menuRef}
          style={menuLayout}
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
        </MenuShell>
      </Chip>
    </div>
  );
}

interface ChipProps {
  ariaControls?: string;
  ariaDescribedBy?: string;
  ariaDisabled?: boolean;
  ariaExpanded: boolean;
  ariaLabel: string;
  dataPending?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  labelId?: string;
  menuId: string;
  onOpen: (trigger: HTMLButtonElement) => void;
  open: boolean;
  title: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}

function Chip({
  ariaControls,
  ariaDescribedBy,
  ariaDisabled,
  ariaExpanded,
  ariaLabel,
  dataPending,
  disabled,
  icon,
  label,
  labelId,
  onOpen,
  open,
  title,
  triggerRef,
  children,
}: ChipProps) {
  return (
    <div className="composer-menu-anchor">
      <button
        aria-controls={ariaControls}
        aria-describedby={ariaDescribedBy}
        aria-disabled={ariaDisabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        className="composer-chip"
        data-pending={dataPending || undefined}
        disabled={disabled}
        onClick={(event) => onOpen(event.currentTarget)}
        ref={triggerRef}
        title={title}
        type="button"
      >
        {icon}
        <span className="composer-chip__label" id={labelId}>{label}</span>
        <ChevronDown aria-hidden="true" className="composer-chip__chevron" size={13} />
      </button>
      {open ? children : null}
    </div>
  );
}

function MenuShell({
  ariaLabel,
  ariaLabelledBy,
  id,
  menuRef,
  style,
  children,
}: {
  ariaLabel?: string;
  ariaLabelledBy?: string;
  id: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className="composer-menu"
      id={id}
      ref={menuRef}
      role="dialog"
      style={style}
    >
      {children}
    </div>
  );
}
