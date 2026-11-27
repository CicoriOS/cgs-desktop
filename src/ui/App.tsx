import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SettingsApi } from "../core/settings";
import { useT } from "../i18n";
import { BtwPanel } from "./BtwPanel";
import { useClientState, useReadOnly } from "./client-context";
import { Composer } from "./composer/Composer";
import { Dock } from "./Dock";
import { useFileDrop } from "./drop";
import { DialogHost } from "./dialogs/DialogHost";
import { desktop } from "./desktop";
import { FEATURES } from "./features";
import { HistoryLoading } from "./HistoryLoading";
import type { NativeProvider, PreviewSignIns } from "./provider-preview";
import { baseName, cx, plainTitle } from "./format";
import { RightPanel } from "./right/RightPanel";
import { RpcDrawer } from "./RpcDrawer";
import { SettingsPage } from "./settings/SettingsPage";
import { Sidebar } from "./Sidebar";
import { SubagentWindow } from "./SubagentWindow";
import { StatsPanel } from "./StatsPanel";
import { Toast } from "./Toast";
import { Topbar } from "./Topbar";
import { Transcript } from "./transcript/Transcript";
import { isMobile } from "./viewport";
import { WorkspaceDialog } from "./WorkspaceDialog";

const SUBAGENT_Z = 50;

export function App({ profileUrl, settingsApi }: { profileUrl?: string; settingsApi?: SettingsApi }) {
  const t = useT();
  const empty = useClientState((s) => s.turns.length === 0 && !s.loading); // while a history loads the page is not "new"
  const [side, setSide] = useState(() => !isMobile()); // a drawer on narrow screens: closed until asked for
  const [right, setRight] = useState(false);
  const [btw, setBtw] = useState(false);
  const [stats, setStats] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [rpc, setRpc] = useState(false);
  const [settings, setSettings] = useState(false);
  const [previewSignIns, setPreviewSignIns] = useState<PreviewSignIns>({});
  const signInPreview = (id: NativeProvider["id"]) =>
    setPreviewSignIns((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
  const settingsOpener = useRef<HTMLElement>(null);
  const readOnly = useReadOnly();
  const session = useClientState((s) => s.sessionFile);
  const desktopTitle = useClientState((s) => {
    if (!desktop) return "";
    const workspace = s.workspaces.find((w) => w.cwd === s.activeCwd);
    const saved = s.sessionFile && workspace?.sessions.find((row) => row.path === s.sessionFile);
    const child = s.children.find((row) => row.id === s.childId);
    const title = plainTitle((saved && saved.title) || child?.title || "");
    return title || (s.activeCwd ? baseName(s.activeCwd.replaceAll("\\", "/")) : "");
  });
  const [subagents, setSubagents] = useState<string[]>([]); // open subagent windows, the last one on top
  const openSubagent = (id: string) => setSubagents((l) => [...l.filter((x) => x !== id), id]);
  const focusSubagent = (id: string) => setSubagents((l) => (l.at(-1) === id ? l : [...l.filter((x) => x !== id), id]));

  useFileDrop();

  useEffect(() => {
    document.title = desktop ? (desktopTitle ? `CGS Desktop - ${desktopTitle}` : "CGS Desktop") : t("app.title");
  }, [t, desktopTitle]);

  const openSettings = () => {
    settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettings(true);
  };

  useEffect(() => {
    if (!FEATURES.settings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.key !== "," || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (settings) setSettings(false);
      else openSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings]);

  useLayoutEffect(() => {
    if (settings) return;
    settingsOpener.current?.focus({ preventScroll: true });
    settingsOpener.current = null;
  }, [settings]);

  useEffect(() => setSubagents([]), [session]); // another session has other subagents

  return (
    <div id="app" className={cx(empty && "empty", !side && "side-hidden")}>
      <div className="app-workspace" inert={settings}>
        <Sidebar onAddWorkspace={() => setWorkspaceDialog(true)} onNavigate={() => isMobile() && setSide(false)} onOpenSettings={openSettings} previewSignIns={settingsApi?.preview ? previewSignIns : undefined} />
        <div className="side-scrim" onClick={() => setSide(false)} />
        <div id="stage">
          {/* One title bar over the conversation and the right side bar, so the window buttons stay at the window's corner. */}
          <Topbar onToggleSide={() => setSide((v) => !v)} onToggleRight={() => setRight((v) => !v)} onToggleBtw={() => setBtw((v) => !v)} onToggleStats={() => setStats((v) => !v)} inSession={!empty} />
          <div id="body">
            <main id="main">
              <section id="scroller">
                {empty && <div id="empty-hello">{t("empty.hello")}</div>}
                <Transcript />
                <HistoryLoading />
              </section>
              {!readOnly && <DialogHost />}
              <Dock onOpenSubagent={openSubagent} />
              {!readOnly && <Composer />}
              {btw && !empty && <BtwPanel onClose={() => setBtw(false)} />}
              {stats && !empty && <StatsPanel onClose={() => setStats(false)} />}
            </main>
            {FEATURES.rightPanel && right && <RightPanel />}
          </div>
        </div>
        {workspaceDialog && <WorkspaceDialog onClose={() => setWorkspaceDialog(false)} />}
        {!readOnly && <button type="button" id="rpc-pill" title={t("rpc.pill")} onClick={() => setRpc((v) => !v)}>RPC</button>}
        {rpc && !readOnly && <RpcDrawer onClose={() => setRpc(false)} />}
        {subagents.map((id, slot) => (
          <SubagentWindow key={id} id={id} slot={slot} z={SUBAGENT_Z + slot} onClose={() => setSubagents((l) => l.filter((x) => x !== id))} onFocus={() => focusSubagent(id)} />
        ))}
      </div>
      {settings && <SettingsPage profileUrl={profileUrl} api={settingsApi} onClose={() => setSettings(false)} previewSignIns={previewSignIns} onPreviewSignIn={signInPreview} />}
      <Toast />
    </div>
  );
}
