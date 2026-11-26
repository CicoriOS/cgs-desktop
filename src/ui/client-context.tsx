import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import { t } from "../i18n";
import type { Actions, Client, ClientState } from "../core/types";

interface Scope {
  client: Client;
  actions: Actions;
  readOnly: boolean;
}

const Ctx = createContext<Scope | undefined>(undefined);

/** Actions a read-only view may still call. Every other action is refused with a notice. */
const READ_ONLY_ALLOWED: Record<string, true> = { notify: true, pickerRows: true, thinkingLevels: true, completePath: true };

function readOnlyActions(actions: Actions): Actions {
  const guarded: Record<string, unknown> = {};
  for (const key of Object.keys(actions)) {
    const value = (actions as unknown as Record<string, (...args: unknown[]) => unknown>)[key]!;
    guarded[key] = READ_ONLY_ALLOWED[key]
      ? value.bind(actions)
      : () => {
          actions.notify(t("connect.readonly.notice"));
          return Promise.resolve();
        };
  }
  return guarded as unknown as Actions;
}

/** `readOnly`: the view shows the session but no action can change it (taken over elsewhere). */
export function ClientProvider({ client, readOnly = false, children }: { client: Client; readOnly?: boolean; children: ReactNode }) {
  const actions = useMemo(() => (readOnly ? readOnlyActions(client.actions) : client.actions), [client, readOnly]);
  const scope = useMemo<Scope>(() => ({ client, actions, readOnly }), [client, actions, readOnly]);
  return <Ctx.Provider value={scope}>{children}</Ctx.Provider>;
}

function useScope(): Scope {
  const s = useContext(Ctx);
  if (!s) throw new Error("ClientProvider is missing");
  return s;
}

export function useClient(): Client {
  return useScope().client;
}

/** Subscribes to a slice of the state. The selector must return a stable value (a field or an existing object), not a fresh one. */
export function useClientState<T>(select: (s: ClientState) => T): T {
  const c = useClient();
  return useSyncExternalStore(c.subscribe, () => select(c.getState()));
}

export const useActions = (): Actions => useScope().actions;

export const useReadOnly = (): boolean => useScope().readOnly;
