import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileEntry } from "../../core/types";
import { useT } from "../../i18n";
import { useActions } from "../client-context";
import { cx } from "../format";
import type { GitState } from "./useGit";
import { STATUS_LETTER } from "./Changes";

type Listing = FileEntry[] | "loading" | { error: string };

/** The workspace's folders, loaded one level at a time as they are opened; changed files carry their Git letter. */
export function FileTree({ cwd, git, reload, collapse, onOpen }: { cwd: string; git: GitState; reload: number; collapse: number; onOpen: (path: string) => void }) {
  const t = useT();
  const actions = useActions();
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(
    (dir: string) => {
      setListings((l) => (Array.isArray(l[dir]) ? l : { ...l, [dir]: "loading" })); // a folder that is already listed stays on screen while it refreshes
      actions.listDir(dir).then(
        (entries) => setListings((l) => ({ ...l, [dir]: entries })),
        (e) => setListings((l) => ({ ...l, [dir]: { error: e instanceof Error ? e.message : String(e) } })),
      );
    },
    [actions],
  );

  useEffect(() => setListings({}), [cwd]);

  // A new workspace, a refresh or a change on disk: read the root again and every folder that is still open.
  useEffect(() => {
    load(cwd);
    // `open` is read per reload on purpose: opening a folder loads that folder only.
    for (const dir of open) if (dir.startsWith(`${cwd}/`)) load(dir);
  }, [cwd, reload, load]);

  useEffect(() => setOpen(new Set()), [cwd, collapse]);

  const status = useMemo(() => new Map(git.files.map((f) => [f.path, f.status])), [git.files]);
  const dirty = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of git.files) for (let p = f.path.slice(0, f.path.lastIndexOf("/")); p.length > cwd.length; p = p.slice(0, p.lastIndexOf("/"))) dirs.add(p);
    return dirs;
  }, [git.files, cwd]);

  const toggle = (dir: string) => {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!Array.isArray(listings[dir])) load(dir);
      }
      return next;
    });
  };

  const render = (dir: string, depth: number) => {
    const listing = listings[dir];
    if (listing === undefined || listing === "loading") return depth === 0 ? <div className="right-note">{t("right.loading")}</div> : null;
    if (!Array.isArray(listing)) return <div className="right-note" style={{ paddingLeft: 12 + depth * 14 }}>{t("right.failed", { error: listing.error })}</div>;
    if (!listing.length) return <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>{t("right.files.empty")}</div>;
    return listing.map((entry) => {
      const expanded = entry.dir && open.has(entry.path);
      const kind = status.get(entry.path);
      return (
        <div key={entry.path}>
          <button type="button" className={cx("tree-row", entry.dir ? "dir" : "leaf")} style={{ paddingLeft: 8 + depth * 14 }} title={entry.path} onClick={() => (entry.dir ? toggle(entry.path) : onOpen(entry.path))}>
            {entry.dir ? <ChevronRight className={cx("i tree-chev", expanded && "open")} /> : <span className="tree-chev" />}
            {entry.dir ? expanded ? <FolderOpen className="i" /> : <Folder className="i" /> : <File className="i" />}
            <span className="tree-name" data-kind={kind}>{entry.name}</span>
            {kind && <span className="stat-letter" data-kind={kind} title={t(`right.status.${kind}`)}>{STATUS_LETTER[kind]}</span>}
            {entry.dir && dirty.has(entry.path) && !expanded && <span className="tree-dot" />}
          </button>
          {expanded && render(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return <div className="tree">{render(cwd, 0)}</div>;
}
