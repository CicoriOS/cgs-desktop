import { createContext, useContext } from "react";
import { useClientState } from "../client-context";

/** What a transcript's live indicators read: whether its agent is running and at which thinking level. */
export interface RunScope {
  streaming: boolean;
  level: string;
}

const Scope = createContext<RunScope | undefined>(undefined);

/** A subagent window supplies its own scope; the main transcript has none and follows the client's run state (ADR 0037). */
export const RunScopeProvider = Scope.Provider;

export function useRunScope(): RunScope {
  const streaming = useClientState((s) => s.run.streaming);
  const level = useClientState((s) => s.thinking.resolved);
  return useContext(Scope) ?? { streaming, level };
}

/** True inside a subagent window: no fork, no edit-and-resend, no actions on the session. */
export function useInSubagent(): boolean {
  return useContext(Scope) !== undefined;
}
