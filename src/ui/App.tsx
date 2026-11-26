import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { BtwPanel } from "./BtwPanel";
import { useClientState } from "./client-context";
import { Composer } from "./composer/Composer";
import { cx } from "./format";
import { RpcDrawer } from "./RpcDrawer";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";
import { Topbar } from "./Topbar";
import { Transcript } from "./transcript/Transcript";
import { isMobile } from "./viewport";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function App() {
  const t = useT();
  const empty = useClientState((s) => s.turns.length === 0);
  const [side, setSide] = useState(() => !isMobile()); // a drawer on narrow screens: closed until asked for
  const [right, setRight] = useState(false);
  const [btw, setBtw] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [rpc, setRpc] = useState(false);

  useEffect(() => {
    document.title = t("app.title");
  }, [t]);

  return (
    <div id="app" className={cx(empty && "empty", !side && "side-hidden")}>
      <Sidebar onAddWorkspace={() => setWorkspaceDialog(true)} onNavigate={() => isMobile() && setSide(false)} />
      <div className="side-scrim" onClick={() => setSide(false)} />
      <main id="main">
        <Topbar onToggleSide={() => setSide((v) => !v)} onToggleRight={() => setRight((v) => !v)} onToggleBtw={() => setBtw((v) => !v)} showBtw={!empty} />
        <section id="scroller">
          {empty && <div id="empty-hello">{t("empty.hello")}</div>}
          <Transcript />
        </section>
        <Composer />
        {btw && !empty && <BtwPanel onClose={() => setBtw(false)} />}
      </main>
      {right && <aside id="right"><div className="placeholder">{t("right.placeholder")}</div></aside>}
      {workspaceDialog && <WorkspaceDialog onClose={() => setWorkspaceDialog(false)} />}
      <button type="button" id="rpc-pill" title={t("rpc.pill")} onClick={() => setRpc((v) => !v)}>RPC</button>
      {rpc && <RpcDrawer onClose={() => setRpc(false)} />}
      <Toast />
    </div>
  );
}
