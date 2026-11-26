import { useEffect, useState } from "react";
import { useActions, useClientState } from "./client-context";
import { baseName, cx, relativeTime } from "./format";
import { ChevronIcon, EditIcon, FolderIcon, FolderPlusIcon } from "./icons";
import { Ring } from "./ring";
import { t as translate, useT } from "../i18n";

const REFRESH_AGE_MS = 30_000;

/** Switching workspace restarts the dev bridge's omp, which aborts a running task: ask first. */
export function useConfirmLeave(): (cwd: string) => boolean {
  const streaming = useClientState((s) => s.run.streaming);
  const cwd = useClientState((s) => s.cwd);
  return (target) => !streaming || target === cwd || confirm(translate("side.confirmLeave"));
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** `onNavigate` runs after a pick that leaves the sidebar (a session, a new chat): the mobile drawer closes then. */
export function Sidebar({ onAddWorkspace, onNavigate }: { onAddWorkspace: () => void; onNavigate: () => void }) {
  const t = useT();
  const actions = useActions();
  const workspaces = useClientState((s) => s.workspaces);
  const activeCwd = useClientState((s) => s.activeCwd);
  const sessionFile = useClientState((s) => s.sessionFile);
  const run = useClientState((s) => s.run);
  const level = useClientState((s) => s.thinking.resolved);
  const confirmLeave = useConfirmLeave();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const now = useNow(REFRESH_AGE_MS);

  return (
    <aside id="sidebar">
      <div className="side-top">
        <button type="button" id="new-chat" className="pill" title={t("side.newChat")} onClick={() => confirmLeave(activeCwd) && (onNavigate(), void actions.newSession())}>
          <EditIcon />
          <span>{t("side.newChat")}</span>
        </button>
        <button type="button" id="new-ws" className="pill" title={t("side.addWorkspace")} aria-label={t("side.addWorkspace")} onClick={() => (onNavigate(), onAddWorkspace())}>
          <FolderPlusIcon />
        </button>
      </div>
      <nav id="tree">
        {workspaces.map((w) => {
          const current = w.cwd === activeCwd;
          const open = expanded[w.cwd] ?? current;
          return (
            <div key={w.cwd} className={cx("ws", open && "open", current && "current")}>
              <div className="ws-head" title={w.cwd} onClick={() => setExpanded((x) => ({ ...x, [w.cwd]: !open }))}>
                <ChevronIcon />
                <FolderIcon />
                <span className="name">{baseName(w.cwd)}</span>
              </div>
              {open && (
                <div className="ws-sessions">
                  {w.sessions.length ? (
                    w.sessions.map((s) => {
                      const active = s.path === sessionFile;
                      return (
                        <div key={s.path} className={cx("sess", active && "active")} title={s.title} onClick={() => confirmLeave(w.cwd) && (onNavigate(), void actions.openSession(s.path, w.cwd))}>
                          <span className="t">{s.title}</span>
                          {active && run.streaming ? <Ring small state={run.state} level={level} /> : <span className="age">{relativeTime(s.updatedAt, now)}</span>}
                        </div>
                      );
                    })
                  ) : (
                    <div className="ws-empty">{t("side.noChats")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
