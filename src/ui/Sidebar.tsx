import { useEffect, useMemo, useState } from "react";
import { useActions, useClientState } from "./client-context";
import { baseName, cx, relativeTime } from "./format";
import { ChevronIcon, EditIcon, FolderIcon, FolderPlusIcon, DeviceIcon } from "./icons";
import { Ring } from "./ring";
import { useT } from "../i18n";

const REFRESH_AGE_MS = 30_000;

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
  const children = useClientState((s) => s.children);
  const title = useClientState((s) => s.title);
  const activeCwd = useClientState((s) => s.activeCwd);
  const sessionFile = useClientState((s) => s.sessionFile);
  const run = useClientState((s) => s.run);
  const device = useClientState((s) => s.device);
  const level = useClientState((s) => s.thinking.resolved);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const now = useNow(REFRESH_AGE_MS);
  const hasWorkspace = !!activeCwd || workspaces.length > 0;
  const byPath = useMemo(() => new Map(children.filter((c) => c.sessionPath).map((c) => [c.sessionPath!, c])), [children]);
  const tree = useMemo(() => {
    // omp only writes a new session file once it has something to save. Show live sessions even before then.
    const pending = children.flatMap((c) => c.sessionPath && c.title ? [{ cwd: c.cwd, path: c.sessionPath, id: c.id, title: c.title, updatedAt: c.updatedAt }] : []);
    if (activeCwd && sessionFile && title) pending.push({ cwd: activeCwd, path: sessionFile, id: sessionFile, title, updatedAt: now });
    const byCwd = new Map(workspaces.map((w) => [w.cwd, [...w.sessions]]));
    if (activeCwd && !byCwd.has(activeCwd)) byCwd.set(activeCwd, []);
    for (const { cwd, ...row } of pending) {
      const rows = byCwd.get(cwd) ?? [];
      if (!rows.some((r) => r.path === row.path)) rows.unshift(row);
      byCwd.set(cwd, rows);
    }
    return [...byCwd].map(([cwd, sessions]) => ({ cwd, sessions }));
  }, [workspaces, children, activeCwd, sessionFile, title, now]);

  return (
    <aside id="sidebar">
      <div className="brand">
        <img src="/cgs-logo.svg" alt="" width={30} height={30} />
        <span>CGS Connect</span>
      </div>
      <div className="side-top">
        {hasWorkspace ? (
          <>
            <button type="button" id="new-chat" className="pill primary" title={t("side.newChat")} onClick={() => (onNavigate(), void actions.newSession())}>
              <EditIcon />
              <span>{t("side.newChat")}</span>
            </button>
            <button type="button" id="new-ws" className="pill" title={t("side.addWorkspace")} aria-label={t("side.addWorkspace")} onClick={() => (onNavigate(), onAddWorkspace())}>
              <FolderPlusIcon />
            </button>
          </>
        ) : (
          <button type="button" id="new-ws" className="pill primary" onClick={() => (onNavigate(), onAddWorkspace())}>
            <FolderPlusIcon />
            <span>{t("side.addWorkspace")}</span>
          </button>
        )}
      </div>
      <nav id="tree">
        {tree.map((w) => {
          const current = w.cwd === activeCwd;
          const open = expanded[w.cwd] ?? (current || w.sessions.some((s) => {
            const c = byPath.get(s.path);
            return c && (c.ring !== "idle" || c.unseen);
          }));
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
                      const child = byPath.get(s.path);
                      const ring = active ? (run.streaming ? (run.state === "think" ? "think" : "work") : "idle") : child?.ring ?? "idle";
                      const unseen = !active && child?.unseen;
                      return (
                        <button type="button" key={s.path} className={cx("sess", active && "active")} title={s.title} aria-current={active ? "true" : undefined} onClick={() => (onNavigate(), void actions.openSession(s.path, w.cwd))}>
                          <span className="t">{active && title ? title : s.title}</span>
                          <Ring small state={ring} level={active ? level : child?.level ?? "high"} />
                          {unseen && <span className="unseen" role="img" title={t("side.unseen")} aria-label={t("side.unseen")} />}
                          {ring === "idle" && !unseen && <span className="age">{relativeTime(s.updatedAt, now)}</span>}
                        </button>
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
      {device && <div id="device" title={t("side.device", { name: device })}><DeviceIcon /><span>{device}</span></div>}
    </aside>
  );
}
