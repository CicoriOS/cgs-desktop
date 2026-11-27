import { ArrowDown, ArrowUp, Check, GitBranch, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitBranch as Branch } from "../../../core/types";
import { useT } from "../../../i18n";
import { avatarColor, avatarLetter } from "../../avatar";
import { useActions } from "../../client-context";
import { cx, relativeTime } from "../../format";

export function Author({ name }: { name: string }) {
  return (
    <span className="git-avatar" style={{ background: avatarColor(name) }} aria-hidden="true">
      {avatarLetter(name)}
    </span>
  );
}

/**
 * The branch list under the branch button: local branches, then remote ones nobody here follows, each with how far it is from its upstream
 * and who touched it last. Typing filters; a name that matches nothing offers to create the branch. Picking a remote branch starts a local
 * one that follows it (the host does that in `gitCheckout`).
 */
export function BranchMenu({ current, onPick, onClose }: { current?: string; onPick: (branch: string, create: boolean) => void; onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  const [branches, setBranches] = useState<Branch[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    actions.gitBranches().then(
      (list) => live && setBranches(list),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [actions]);

  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)), [branches, q]);
  const local = shown.filter((b) => !b.remote);
  const remote = shown.filter((b) => b.remote);
  const canCreate = q.length > 0 && !(branches ?? []).some((b) => b.name.toLowerCase() === q) && !/\s/.test(query.trim());

  const row = (b: Branch) => (
    <button key={b.name} type="button" className={cx("branch-row", b.current && "current")} onClick={() => onPick(b.name, false)}>
      <span className="branch-check">{b.current && <Check className="i" />}</span>
      <span className="branch-name" title={b.upstream ? t("git.upstream", { upstream: b.upstream }) : b.name}>
        {b.name}
      </span>
      {b.behind > 0 && (
        <span className="git-count">
          <ArrowDown className="i" />
          {b.behind}
        </span>
      )}
      {b.ahead > 0 && (
        <span className="git-count">
          <ArrowUp className="i" />
          {b.ahead}
        </span>
      )}
      <Author name={b.author} />
      <span className="branch-time">{relativeTime(b.time)}</span>
    </button>
  );

  return (
    <div className="branch-menu" ref={box} role="dialog" aria-label={t("git.branch")}>
      <input autoFocus className="branch-filter" value={query} placeholder={t("git.branchFilter")} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && canCreate && !shown.length && onPick(query.trim(), true)} />
      <div className="branch-list">
        {canCreate && (
          <button type="button" className="branch-row create" onClick={() => onPick(query.trim(), true)}>
            <Plus className="i" />
            <span className="branch-name">{t("git.createBranch", { name: query.trim() })}</span>
          </button>
        )}
        {error && <div className="right-note">{t("right.failed", { error })}</div>}
        {!branches && !error && <div className="right-note">{t("right.loading")}</div>}
        {branches && !shown.length && !canCreate && <div className="right-note">{t("git.noBranches")}</div>}
        {local.length > 0 && <h5><GitBranch className="i" />{t("git.localBranches")}</h5>}
        {local.map(row)}
        {remote.length > 0 && <h5><GitBranch className="i" />{t("git.remoteBranches")}</h5>}
        {remote.map(row)}
      </div>
    </div>
  );
}
