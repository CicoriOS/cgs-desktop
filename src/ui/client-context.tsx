import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { Actions, Client, ClientState } from "../core/types";

const Ctx = createContext<Client | undefined>(undefined);

export function ClientProvider({ client, children }: { client: Client; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useClient(): Client {
  const c = useContext(Ctx);
  if (!c) throw new Error("ClientProvider is missing");
  return c;
}

/** Subscribes to a slice of the state. The selector must return a stable value (a field or an existing object), not a fresh one. */
export function useClientState<T>(select: (s: ClientState) => T): T {
  const c = useClient();
  return useSyncExternalStore(c.subscribe, () => select(c.getState()));
}

export const useActions = (): Actions => useClient().actions;
