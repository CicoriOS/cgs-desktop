import { ChevronsDownUp, FilePenLine, Folder, GitBranch, RefreshCw } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { useClientState } from "../client-context";
import { cx } from "../format";
import { TaskPane } from "./Changes";
import { taskChanges } from "./changes";
import { FilePreview } from "./FilePreview";
import { FileTree } from "./FileTree";
import { GitPane } from "./git/GitPane";
import { pathCount } from "./git/model";
import { useWorkspaceTick } from "./live";
import { useGit } from "./useGit";

type Tab = "task" | "git" | "files";

const WIDTH_KEY = "cgs.rightWidth";
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 300;

const storedWidth = (): number => {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
};

/**
 * The right side bar: what this task changed, the workspace's Git changes, and its files with a preview. It sits under the title bar
 * (which carries the window buttons), and unlike the left side bar it is a plain opaque surface.
 */
export function RightPanel() {
  const t = useT();
  const cwd = useClientState((s) => s.activeCwd);
  const turns = useClientState((s) => s.turns);
  const tools = useClientState((s) => s.tools);
  const [tab, setTab] = useState<Tab>("task");
  const [file, setFile] = useState<string>();
  const [manual, setManual] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // commit messages, one per workspace, kept while the tab is away
  const [collapse, setCollapse] = useState(0);
  const [width, setWidth] = useState(storedWidth);
  const reload = manual + useWorkspaceTick();
  const git = useGit(reload);
  const taskCount = useMemo(() => taskChanges(turns, tools).length, [turns, tools]);

  useEffect(() => setFile(undefined), [cwd]);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = width;
      const max = Math.floor(window.innerWidth * 0.6);
      const move = (ev: PointerEvent) => setWidth(Math.min(max, Math.max(MIN_WIDTH, startWidth + startX - ev.clientX)));
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        setWidth((w) => (localStorage.setItem(WIDTH_KEY, String(w)), w));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
    },
    [width],
  );

  const tabs: { id: Tab; label: string; icon: typeof Folder; count: number }[] = [
    { id: "task", label: t("right.tab.task"), icon: FilePenLine, count: taskCount },
    { id: "git", label: t("right.tab.git"), icon: GitBranch, count: pathCount(git.files) },
    { id: "files", label: t("right.tab.files"), icon: Folder, count: 0 },
  ];

  return (
    <aside id="right" style={{ width }}>
      <div className="right-resize" role="separator" aria-orientation="vertical" title={t("right.resize")} onPointerDown={startResize} onDoubleClick={() => (setWidth(DEFAULT_WIDTH), localStorage.removeItem(WIDTH_KEY))} />
      <div className="right-tabs" role="tablist">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={cx("right-tab", tab === id && "active")} title={label} onClick={() => (setTab(id), id === "files" && setFile(undefined))}>
            <Icon className="i" />
            <span>{label}</span>
            {count > 0 && <span className="right-count">{count}</span>}
          </button>
        ))}
        <span className="grow" />
        {tab === "files" && !file && (
          <button type="button" className="icon small" title={t("right.collapse")} aria-label={t("right.collapse")} onClick={() => setCollapse((n) => n + 1)}>
            <ChevronsDownUp className="i" />
          </button>
        )}
        {tab !== "task" && (
          <button type="button" className="icon small" title={t("right.refresh")} aria-label={t("right.refresh")} onClick={() => setManual((n) => n + 1)}>
            <RefreshCw className={cx("i", git.loading && "spin")} />
          </button>
        )}
      </div>
      <div className="right-body">
        {tab === "task" && <TaskPane cwd={cwd} />}
        {tab === "git" && <GitPane git={git} cwd={cwd} draft={drafts[cwd] ?? ""} setDraft={(text) => setDrafts((d) => ({ ...d, [cwd]: text }))} onChanged={() => setManual((n) => n + 1)} />}
        {tab === "files" && (file ? <FilePreview cwd={cwd} path={file} reload={reload} onBack={() => setFile(undefined)} /> : <FileTree cwd={cwd} git={git} reload={reload} collapse={collapse} onOpen={setFile} />)}
      </div>
    </aside>
  );
}
