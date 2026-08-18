import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { BrowserSnapshot } from "../shared/protocol";
import { App, type ClientSettings } from "./App";
import { assertCompatibleSnapshot } from "./bootstrap";
import { CodexWebClient } from "./websocket";

async function bootstrap(): Promise<BrowserSnapshot> {
  const response = await fetch("/api/bootstrap", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}`);
  return assertCompatibleSnapshot(await response.json());
}

async function loadSettings(): Promise<ClientSettings> {
  const response = await fetch("/api/settings", { credentials: "same-origin" });
  if (!response.ok) return { recentDirectories: [] };
  return response.json() as Promise<ClientSettings>;
}

async function saveSettings(settings: ClientSettings): Promise<void> {
  await fetch("/api/settings", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

Promise.all([bootstrap(), loadSettings()])
  .then(([snapshot, settings]) => {
    const client = new CodexWebClient(snapshot);
    client.connect();
    createRoot(root).render(
      <StrictMode>
        <App
          client={client}
          initialSettings={settings}
          initialSnapshot={snapshot}
          onPersistSettings={(value) => void saveSettings(value)}
        />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    root.innerHTML = `<main class="boot-error"><strong>Codex Web could not start</strong><p>${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p></main>`;
  });

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}
