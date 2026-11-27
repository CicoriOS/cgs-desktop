import { type ReactNode, useMemo, useState } from "react";
import type { GitFileKind } from "../../core/types";
import { useT } from "../../i18n";
import { useActions, useClientState } from "../client-context";
import { baseName, cx } from "../format";
import type { DiffLine } from "../transcript/tools/diff";
import { DiffView } from "../transcript/tools/DiffView";
import { langOf } from "../transcript/tools/highlight";
import { taskChanges } from "./changes";
import { dirName, relativeTo } from "./paths";
import { parseUnified } from "./patch";

export const STATUS_LETTER: Record<GitFileKind, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };

/** A list of changed files with the diff of the picked one below it. */
export function ChangeLayout({ rows, children }: { rows: ReactNode; children: ReactNode }) {
  return (
    <div className="chg">
      <div className="chg-list">{rows}</div>
      <div className="chg-diff">{children}</div>
    </div>
  );
}

export function Row({ path, cwd, active, badge, meta, onClick }: { path: string; cwd: string; active: boolean; badge: ReactNode; meta?: ReactNode; onClick: () => void }) {
  const rel = relativeTo(cwd, path);
  const dir = dirName(rel);
  return (
    <button type="button" className={cx("chg-row", active && "active")} title={rel} onClick={onClick}>
      {badge}
      <span className="chg-name">{baseName(rel)}</span>
      {dir && <span className="chg-dir">{dir}</span>}
      {meta}
    </button>
  );
}

export function Message({ children }: { children: ReactNode }) {
  return <div className="right-note">{children}</div>;
}

// ---------------------------------------------------------------------------------------------- the task's own edits
/** What this task changed, read from the edit and write calls in the conversation: needs no host. */
export function TaskPane({ cwd }: { cwd: string }) {
  const t = useT();
  const turns = useClientState((s) => s.turns);
  const tools = useClientState((s) => s.tools);
  const changes = useMemo(() => taskChanges(turns, tools), [turns, tools]);
  const [picked, setPicked] = useState<string>();
  const current = changes.find((c) => c.path === picked) ?? changes[0];
  if (!changes.length) return <Message>{t("right.task.empty")}</Message>;
  return (
    <ChangeLayout
      rows={changes.map((c) => (
        <Row
          key={c.path}
          path={c.path}
          cwd={cwd}
          active={c.path === current?.path}
          badge={<span className="stat-letter" data-kind="modified">{STATUS_LETTER.modified}</span>}
          meta={
            <span className="chg-stat" title={t("right.task.calls", { n: c.edits })}>
              <b className="add">+{c.added}</b> <b className="del">−{c.removed}</b>
            </span>
          }
          onClick={() => setPicked(c.path)}
        />
      ))}
    >
      {current && <DiffView lines={current.lines} lang={langOf(current.path)} />}
    </ChangeLayout>
  );
}
