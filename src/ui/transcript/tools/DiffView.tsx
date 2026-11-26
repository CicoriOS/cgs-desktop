import { useMemo, useState } from "react";
import type { DiffLine } from "./diff";
import { highlightDiff } from "./highlight";
import { useT } from "../../../i18n";

const MARK = { add: "+", del: "−", ctx: " ", gap: "" } as const;
const LIMIT = 200;

/** Lines of a diff with old/new line numbers and +/- colouring; `lang` adds syntax highlighting. Long diffs show the first LIMIT lines until expanded. */
export function DiffView({ lines, lang }: { lines: DiffLine[]; lang?: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const html = useMemo(() => highlightDiff(lines, lang), [lines, lang]);
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
            {html[i] === undefined ? <span className="tx">{l.text || " "}</span> : <span className="tx" dangerouslySetInnerHTML={{ __html: html[i] || " " }} />}
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
