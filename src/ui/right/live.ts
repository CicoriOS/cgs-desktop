import { useEffect, useState } from "react";
import { useActions, useClientState } from "../client-context";

const SETTLE_MS = 150;

/** A number that goes up after the active workspace changed and went quiet: add it to what a view loads on, and it reloads live. */
export function useWorkspaceTick(): number {
  const actions = useActions();
  const cwd = useClientState((s) => s.activeCwd);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!cwd) return;
    let timer: number | undefined;
    const stop = actions.watchWorkspace(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((n) => n + 1), SETTLE_MS); // an agent writing many files is one refresh
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [actions, cwd]);
  return tick;
}
