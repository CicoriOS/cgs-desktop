import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AccountFooter } from "./AccountFooter";
import { desktop } from "./desktop";
import { WORKSPACE_DROP } from "./drop";
import { useActions, useClientState, useReadOnly } from "./client-context";
import { baseName, cx, plainTitle, relativeTime } from "./format";
import { ChevronIcon, EditIcon, FolderIcon, FolderPlusIcon, DeviceIcon, PinIcon } from "./icons";
import { Ring } from "./ring";
import type { PreviewSignIns } from "./provider-preview";
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

/**
 * Right-click menu of a workspace row (CGS Desktop only). Removing is not deleting: the conversations stay on disk and are
 * back when the directory is added again, and the menu says so, so nobody hesitates.
 */
function WorkspaceMenu({ cwd, pinned, x, y, onClose }: { cwd: string; pinned: boolean; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return createPortal(
    <div id="ws-menu" role="menu" style={{ left: Math.min(x, innerWidth - 232), top: Math.min(y, innerHeight - 124) }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" autoFocus onClick={() => (onClose(), void actions.pinWorkspace(cwd, !pinned))}>
        <span>{t(pinned ? "side.unpinWorkspace" : "side.pinWorkspace")}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => (onClose(), void actions.removeWorkspace(cwd))}>
        <span>{t("side.removeWorkspace")}</span>
        <small>{t("side.removeWorkspace.d")}</small>
      </button>
    </div>,
    document.body,
  );
}

/** `onNavigate` runs after a pick that leaves the sidebar (a session, a new chat): the mobile drawer closes then. */
export function Sidebar({ onAddWorkspace, onNavigate, onOpenSettings, previewSignIns }: { onAddWorkspace: () => void; onNavigate: () => void; onOpenSettings: () => void; previewSignIns?: PreviewSignIns }) {
  const t = useT();
  const actions = useActions();
  const readOnly = useReadOnly();
  const connection = useClientState((s) => s.connection);
  const status = readOnly ? "readonly" : connection;
  const workspaces = useClientState((s) => s.workspaces);
  const children = useClientState((s) => s.children);
  const title = useClientState((s) => s.title);
  const activeCwd = useClientState((s) => s.activeCwd);
  const sessionFile = useClientState((s) => s.sessionFile);
  const run = useClientState((s) => s.run);
  const device = useClientState((s) => s.device);
  const level = useClientState((s) => s.thinking.resolved);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ cwd: string; pinned: boolean; x: number; y: number }>();
  const now = useNow(REFRESH_AGE_MS);
  const hasWorkspace = !!activeCwd || workspaces.length > 0;
  const byPath = useMemo(() => new Map(children.filter((c) => c.sessionPath).map((c) => [c.sessionPath!, c])), [children]);
  const tree = useMemo(() => {
    // omp only writes a new session file once it has something to save. Show live sessions even before then.
    const pending = children.flatMap((c) => c.sessionPath && c.title ? [{ cwd: c.cwd, path: c.sessionPath, id: c.id, title: c.title, updatedAt: c.updatedAt }] : []);
    if (activeCwd && sessionFile && title) pending.push({ cwd: activeCwd, path: sessionFile, id: sessionFile, title, updatedAt: now });
    const byCwd = new Map(workspaces.map((w) => [w.cwd, [...w.sessions]]));
    const pins = new Map(workspaces.flatMap((w) => (w.pinnedAt === undefined ? [] : [[w.cwd, w.pinnedAt] as const])));
    if (activeCwd && !byCwd.has(activeCwd)) byCwd.set(activeCwd, []);
    for (const { cwd, ...row } of pending) {
      // A workspace taken off the list does not come back through a conversation that is still winding down.
      if (!byCwd.has(cwd)) continue;
      const rows = byCwd.get(cwd) ?? [];
      if (!rows.some((r) => r.path === row.path)) rows.unshift(row);
      byCwd.set(cwd, rows);
    }
    // The device orders them already; a workspace that only appeared through the open conversation joins unpinned, at the end of the list.
    return [...byCwd].map(([cwd, sessions]) => ({ cwd, sessions, pinnedAt: pins.get(cwd) })).sort((a, b) => (b.pinnedAt !== undefined ? 1 : 0) - (a.pinnedAt !== undefined ? 1 : 0) || (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  }, [workspaces, children, activeCwd, sessionFile, title, now]);

  return (
    <aside id="sidebar" data-drop={desktop ? WORKSPACE_DROP : undefined}>
      <div className="brand">
        <img src={`${import.meta.env.BASE_URL}cgs-logo.svg`} alt="" width={30} height={30} />
        <span>{desktop ? "CGS Desktop" : t("app.title")}</span>
      </div>
      {!readOnly && (
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
      )}
      <nav id="tree">
        {tree.map((w) => {
          const current = w.cwd === activeCwd;
          const open = expanded[w.cwd] ?? (current || w.sessions.some((s) => {
            const c = byPath.get(s.path);
            return c && (c.ring !== "idle" || c.unseen);
          }));
          return (
            <div key={w.cwd} className={cx("ws", open && "open", current && "current")}>
              <div
                className="ws-head"
                title={w.cwd}
                onClick={() => setExpanded((x) => ({ ...x, [w.cwd]: !open }))}
                onContextMenu={desktop && !readOnly ? (e) => { e.preventDefault(); setMenu({ cwd: w.cwd, pinned: w.pinnedAt !== undefined, x: e.clientX, y: e.clientY }); } : undefined}
              >
                <ChevronIcon />
                <FolderIcon />
                <span className="name">{baseName(w.cwd)}</span>
                {w.pinnedAt !== undefined && <span className="pin" role="img" title={t("side.pinned")} aria-label={t("side.pinned")}><PinIcon /></span>}
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
                        <button type="button" key={s.path} className={cx("sess", active && "active")} title={plainTitle(s.title)} aria-current={active ? "true" : undefined} onClick={() => (onNavigate(), void actions.openSession(s.path, w.cwd))}>
                          <span className="t">{plainTitle(active && title ? title : s.title)}</span>
                          {ring !== "idle" && <Ring small state={ring} level={active ? level : child?.level ?? "high"} />}
                          {unseen && <span className="unseen" role="img" title={t("side.unseen")} aria-label={t("side.unseen")} />}
                          {/* Another client controls it; our own control needs no mark (ADR 0047). */}
                          {child?.controller && !child.controller.mine && <span className="ctrl" role="img" title={t("control.sideBadge", { name: child.controller.name })} aria-label={t("control.sideBadge", { name: child.controller.name })} />}
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
      {!desktop && device && (
        <div id="device" title={t("side.device", { name: device })}>
          <DeviceIcon />
          <span>{device}</span>
          <span className="dev-status" data-status={status} role="status">
            <i aria-hidden="true" />
            {t(`side.status.${status}`)}
          </span>
        </div>
      )}
      {menu && <WorkspaceMenu {...menu} onClose={() => setMenu(undefined)} />}
      <AccountFooter now={now} onOpenSettings={onOpenSettings} previewSignIns={previewSignIns} />
      {desktop && <div className="drop-hint">{t("side.dropHint")}</div>}
    </aside>
  );
}
