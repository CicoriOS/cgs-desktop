import { useState } from "react";
import type { DiffLine } from "./diff";
import { useT } from "../../../i18n";

const MARK = { add: "+", del: "−", ctx: " ", gap: "" } as const;
const LIMIT = 200;

/** Lines of a diff with old/new line numbers and +/- colouring. Long diffs show the first LIMIT lines until expanded. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, LIMIT);
  return (
    <div className="diff" role="table">
      {shown.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} className="dl gap">
            ⋯
          </div>
        ) : (
          <div key={i} className={`dl ${l.kind}`}>
            <span className="no">{l.no ?? ""}</span>
            <span className="mk">{MARK[l.kind]}</span>
            <span className="tx">{l.text || " "}</span>
          </div>
        ),
      )}
      {lines.length > LIMIT && !all && (
        <button type="button" className="diff-more" onClick={() => setAll(true)}>
          {t("diff.more", { n: lines.length - LIMIT })}
        </button>
      )}
    </div>
  );
}
