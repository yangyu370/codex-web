import { beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { ComposerControls } from "./ComposerControls";

beforeEach(cleanup);

const efforts = [
  { id: "low", description: "Fast" },
  { id: "high", description: "Thorough" },
];

const modelCatalog = [
  { id: "gpt-5.6", displayName: "GPT-5.6", description: "Balanced flagship" },
  { id: "fast", displayName: "Fast", description: "Quick responses" },
];

const profiles = [
  { id: ":read-only", description: "Server read-only description", allowed: true },
  { id: ":workspace", description: "Workspace access", allowed: true },
  { id: ":danger-full-access", description: "Server full access description", allowed: true },
  { id: ":custom", description: "Custom native profile", allowed: true },
  { id: ":blocked", description: "Managed policy blocks this profile", allowed: false },
];

describe("ComposerControls", () => {
  test("gives each permissions menu unique relationships and focuses its selected option when opened", async () => {
    render(
      <>
        <ComposerControls
          efforts={efforts}
          models={modelCatalog}
          onModelChange={() => undefined}
          effort="high"
          onSettingsChange={() => undefined}
          permissionProfile=":workspace"
          permissionProfiles={profiles}
        />
        <ComposerControls
          efforts={efforts}
          models={modelCatalog}
          onModelChange={() => undefined}
          effort="high"
          onSettingsChange={() => undefined}
          permissionProfile=":workspace"
          permissionProfiles={profiles}
        />
      </>,
    );
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button", { name: "Permissions" });
    const firstTrigger = triggers[0]!;
    const secondTrigger = triggers[1]!;
    const firstDescriptionId = firstTrigger.getAttribute("aria-describedby");
    const secondDescriptionId = secondTrigger.getAttribute("aria-describedby");

    expect({
      descriptionsAreUnique: firstDescriptionId !== secondDescriptionId,
      firstDescription: firstDescriptionId ? document.getElementById(firstDescriptionId)?.textContent : undefined,
      secondDescription: secondDescriptionId ? document.getElementById(secondDescriptionId)?.textContent : undefined,
    }).toEqual({
      descriptionsAreUnique: true,
      firstDescription: "Approve when needed",
      secondDescription: "Approve when needed",
    });

    await user.click(firstTrigger);

    expect({
      menuIdsAreUnique: firstTrigger.getAttribute("aria-controls") !== secondTrigger.getAttribute("aria-controls"),
      focusedOptionName: (document.activeElement as HTMLElement | null)?.getAttribute("aria-label"),
    }).toEqual({
      menuIdsAreUnique: true,
      focusedOptionName: "Approve when needed",
    });
  });

  test("shows only the effort degree on the chip and moves the reason into the hover tooltip", () => {
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );

    const effortChip = screen.getByRole("button", { name: "Reasoning effort" });
    expect(effortChip.textContent).toBe("High");
    expect(effortChip.getAttribute("title")).toBe("Thorough");
  });

  test("opens the effort menu with degree-only options and sends the selected id", async () => {
    const changes: unknown[] = [];
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="low"
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reasoning effort" }));

    const menu = screen.getByRole("dialog", { name: "Reasoning effort" });
    expect(menu).not.toBeNull();
    const options = menu.querySelectorAll(".composer-menu__option--simple");
    expect(Array.from(options).map((option) => option.textContent)).toEqual(["Low", "High"]);
    expect(options[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(options[0]?.getAttribute("title")).toBe("Fast");

    await user.click(screen.getByRole("button", { name: "High" }));

    expect(changes).toEqual([{ effort: "high" }]);
    expect(screen.queryByRole("dialog", { name: "Reasoning effort" })).toBeNull();
  });

  test("opens the permissions menu with friendly names and sends the native full-access profile id", async () => {
    const changes: unknown[] = [];
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="low"
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));

    expect(screen.getByRole("dialog", { name: "How should Codex run?" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ask for approval" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve when needed" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Full access" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Full access" }));
    await user.click(screen.getByRole("button", { name: "Reasoning effort" }));
    await user.click(screen.getByRole("button", { name: "High" }));

    expect(changes).toEqual([
      { permissionProfile: ":danger-full-access" },
      { effort: "high" },
    ]);
  });

  test("keeps disallowed profiles disabled and does not select them", async () => {
    const changes: unknown[] = [];
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));

    const blocked = screen.getByRole("button", { name: ":blocked" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByText("Managed policy blocks this profile")).not.toBeNull();
    await user.click(blocked);

    expect(changes).toEqual([]);
  });

  test("dismisses the open permissions menu with Escape and restores trigger focus", async () => {
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Permissions" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("switches between the effort and permission menus", async () => {
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reasoning effort" }));
    expect(screen.getByRole("dialog", { name: "Reasoning effort" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Permissions" }));

    expect(screen.queryByRole("dialog", { name: "Reasoning effort" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "How should Codex run?" })).not.toBeNull();
  });

  test("keeps an unknown allowed profile selectable by its native id", async () => {
    const changes: unknown[] = [];
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByRole("button", { name: ":custom" })).not.toBeNull();
    expect(screen.getByText("Custom native profile")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: ":custom" }));

    expect(changes).toEqual([{ permissionProfile: ":custom" }]);
  });

  test("dismisses the open permissions menu on an outside pointer interaction", async () => {
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByRole("dialog", { name: "How should Codex run?" })).not.toBeNull();
    await user.click(document.body);

    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
  });

  test("closes an open menu when the controls become disabled", async () => {
    const changes: unknown[] = [];
    let disableControls: () => void = () => undefined;
    function Harness() {
      const [controlsDisabled, setControlsDisabled] = useState(false);
      disableControls = () => setControlsDisabled(true);
      return <ComposerControls
        disabled={controlsDisabled}
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />;
    }
    render(<Harness />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByRole("dialog", { name: "How should Codex run?" })).not.toBeNull();

    (document.activeElement as HTMLElement | null)?.blur();
    act(disableControls);

    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
    expect((screen.getByRole("button", { name: "Permissions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(changes).toEqual([]);
  });

  test("selects an option from the keyboard and restores focus to the trigger", async () => {
    const changes: unknown[] = [];
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={(change) => changes.push(change)}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Permissions" });

    await user.click(trigger);
    const fullAccess = screen.getByRole("button", { name: "Full access" });
    fullAccess.focus();
    await user.keyboard("{Enter}");

    expect(changes).toEqual([{ permissionProfile: ":danger-full-access" }]);
    expect(document.activeElement).toBe(trigger);
  });

  test("keeps focus on the non-activatable trigger when selection synchronously becomes pending", async () => {
    const changes: unknown[] = [];
    function PendingHarness() {
      const [settingPending, setSettingPending] = useState(false);
      return <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={(change) => {
          changes.push(change);
          setSettingPending(true);
        }}
        pending={settingPending ? "permissionProfile" : undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />;
    }
    render(<PendingHarness />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Permissions" }) as HTMLButtonElement;

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Full access" }));

    expect(changes).toEqual([{ permissionProfile: ":danger-full-access" }]);
    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "How should Codex run?" })).toBeNull();
    expect(changes).toHaveLength(1);
  });

  test("moves the next-turn hint into the chip tooltips while a turn is running", () => {
    render(
      <ComposerControls
        efforts={efforts}
        models={modelCatalog}
        onModelChange={() => undefined}
        effort="high"
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
        running
      />,
    );

    expect(screen.getByRole("button", { name: "Reasoning effort" }).getAttribute("title"))
      .toBe("Thorough · Applies from the next turn");
    expect(screen.getByRole("button", { name: "Permissions" }).getAttribute("title"))
      .toBe("Ask only when Codex detects a risky operation. · Applies from the next turn");
  });

  test("shows the model display name on its chip and sends the selection through onModelChange", async () => {
    const selections: string[] = [];
    render(
      <ComposerControls
        efforts={efforts}
        effort="high"
        model="gpt-5.6"
        models={modelCatalog}
        onModelChange={(model) => selections.push(model)}
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );
    const user = userEvent.setup();

    const chip = screen.getByRole("button", { name: "Model" });
    expect(chip.textContent).toBe("GPT-5.6");
    expect(chip.getAttribute("title")).toBe("Balanced flagship");

    await user.click(chip);

    const menu = screen.getByRole("dialog", { name: "Model" });
    const options = menu.querySelectorAll(".composer-menu__option--simple");
    expect(Array.from(options).map((option) => option.textContent)).toEqual(["GPT-5.6", "Fast"]);
    expect(options[1]?.getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Fast" }));

    expect(selections).toEqual(["fast"]);
    expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();
  });

  test("hides the model chip when the composer manages the thread model elsewhere", () => {
    render(
      <ComposerControls
        efforts={efforts}
        effort="high"
        models={modelCatalog}
        onModelChange={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
        showModel={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reasoning effort" }).textContent).toBe("High");
  });

  test("preserves an authoritative reasoning effort not yet present in model metadata", () => {
    render(
      <ComposerControls
        efforts={[...efforts, { id: "ultra", description: "Current task value" }]}
        effort="ultra"
        models={modelCatalog}
        onModelChange={() => undefined}
        onSettingsChange={() => undefined}
        permissionProfile=":workspace"
        permissionProfiles={profiles}
      />,
    );

    const chip = screen.getByRole("button", { name: "Reasoning effort" });
    expect(chip.textContent).toBe("Ultra");
    expect(chip.getAttribute("title")).toBe("Current task value");
  });
});
