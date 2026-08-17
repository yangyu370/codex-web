import { createStore } from "zustand/vanilla";

import type { BrowserSnapshot } from "../shared/protocol";

export interface ClientStoreState {
  snapshot: BrowserSnapshot;
  setSnapshot(snapshot: BrowserSnapshot): void;
}

export function createClientStore(snapshot: BrowserSnapshot) {
  return createStore<ClientStoreState>((set) => ({
    snapshot,
    setSnapshot(next) {
      set({ snapshot: next });
    },
  }));
}

