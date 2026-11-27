// Renderer access to the shell's updater (ADR 0046 §6). The red dot on the settings gear and the settings screen both
// listen here; in a browser `desktop.updater` is absent and the hook stays idle.
import { useEffect, useState } from "react";
import type { UpdaterStatus } from "./protocol";
import { desktop } from "../ui/desktop";

/** Whether an update is worth the gear's red dot. */
export function updateBadge(status: UpdaterStatus | undefined): boolean {
  return status?.phase === "available" || status?.phase === "downloaded";
}

/** Current updater status, kept live through `updater.onStatus`. */
export function useUpdaterStatus(): UpdaterStatus | undefined {
  const api = desktop?.updater;
  const [status, setStatus] = useState<UpdaterStatus>();
  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.status().then((current) => {
      if (live) setStatus(current);
    }, () => {});
    const stop = api.onStatus((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, [api]);
  return status;
}
