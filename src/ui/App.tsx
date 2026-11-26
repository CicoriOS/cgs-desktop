import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { BtwPanel } from "./BtwPanel";
import { useClientState, useReadOnly } from "./client-context";
import { Composer } from "./composer/Composer";
import { Dock } from "./Dock";
import { DialogHost } from "./dialogs/DialogHost";
import { FEATURES } from "./features";
import { cx } from "./format";
import { RpcDrawer } from "./RpcDrawer";
import { Sidebar } from "./Sidebar";
import { SubagentWindow } from "./SubagentWindow";
import { StatsPanel } from "./StatsPanel";
import { Toast } from "./Toast";
import { Topbar } from "./Topbar";
import { Transcript } from "./transcript/Transcript";
import { isMobile } from "./viewport";
import { WorkspaceDialog } from "./WorkspaceDialog";

const SUBAGENT_Z = 50;

export function App() {
  const t = useT();
  const empty = useClientState((s) => s.turns.length === 0);
  const [side, setSide] = useState(() => !isMobile()); // a drawer on narrow screens: closed until asked for
  const [right, setRight] = useState(false);
  const [btw, setBtw] = useState(false);
  const [stats, setStats] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [rpc, setRpc] = useState(false);
  const readOnly = useReadOnly();
  const session = useClientState((s) => s.sessionFile);
  const [subagents, setSubagents] = useState<string[]>([]); // open subagent windows, the last one on top
  const openSubagent = (id: string) => setSubagents((l) => [...l.filter((x) => x !== id), id]);
  const focusSubagent = (id: string) => setSubagents((l) => (l.at(-1) === id ? l : [...l.filter((x) => x !== id), id]));

  useEffect(() => {
    document.title = t("app.title");
  }, [t]);

  useEffect(() => setSubagents([]), [session]); // another session has other subagents

  return (
    <div id="app" className={cx(empty && "empty", !side && "side-hidden")}>
      <Sidebar onAddWorkspace={() => setWorkspaceDialog(true)} onNavigate={() => isMobile() && setSide(false)} />
      <div className="side-scrim" onClick={() => setSide(false)} />
      <main id="main">
        <Topbar onToggleSide={() => setSide((v) => !v)} onToggleRight={() => setRight((v) => !v)} onToggleBtw={() => setBtw((v) => !v)} onToggleStats={() => setStats((v) => !v)} inSession={!empty} />
        <section id="scroller">
          {empty && <div id="empty-hello">{t("empty.hello")}</div>}
          <Transcript />
        </section>
        {!readOnly && <DialogHost />}
        <Dock onOpenSubagent={openSubagent} />
        {!readOnly && <Composer />}
        {btw && !empty && <BtwPanel onClose={() => setBtw(false)} />}
        {stats && !empty && <StatsPanel onClose={() => setStats(false)} />}
      </main>
      {FEATURES.rightPanel && right && <aside id="right"><div className="placeholder">{t("right.placeholder")}</div></aside>}
      {workspaceDialog && <WorkspaceDialog onClose={() => setWorkspaceDialog(false)} />}
      {!readOnly && <button type="button" id="rpc-pill" title={t("rpc.pill")} onClick={() => setRpc((v) => !v)}>RPC</button>}
      {rpc && !readOnly && <RpcDrawer onClose={() => setRpc(false)} />}
      {subagents.map((id, slot) => (
        <SubagentWindow key={id} id={id} slot={slot} z={SUBAGENT_Z + slot} onClose={() => setSubagents((l) => l.filter((x) => x !== id))} onFocus={() => focusSubagent(id)} />
      ))}
      <Toast />
    </div>
  );
}
