import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { BrowserSnapshot } from "../shared/protocol";
import { App } from "./App";
import { CodexWebClient } from "./websocket";

async function bootstrap(): Promise<BrowserSnapshot> {
  const response = await fetch("/api/bootstrap", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}`);
  return response.json() as Promise<BrowserSnapshot>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

bootstrap()
  .then((snapshot) => {
    const client = new CodexWebClient(snapshot);
    client.connect();
    createRoot(root).render(
      <StrictMode>
        <App client={client} initialSnapshot={snapshot} />
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
