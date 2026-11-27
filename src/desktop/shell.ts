// Notification clicks land here (ADR 0046 §5): the tray notification carries the child id and its session file, and the
// page opens that conversation the same way the sidebar does.
import { useEffect, useRef } from "react";
import { useActions, useClientState } from "../ui/client-context";
import { desktop } from "../ui/desktop";

export function useShellOpenChild(): void {
  const actions = useActions();
  const children = useClientState((state) => state.children);
  const latest = useRef(children);
  latest.current = children;

  useEffect(() => {
    const shell = desktop?.shell;
    if (!shell) return;
    return shell.onOpenChild((target) => {
      const child = latest.current.find((row) => row.id === target.id);
      const sessionPath = target.sessionPath ?? child?.sessionPath;
      const cwd = target.cwd ?? child?.cwd;
      // A child without a session file yet has nothing to open; the next notification will carry it.
      if (sessionPath && cwd) void actions.openSession(sessionPath, cwd);
    });
  }, [actions]);
}
