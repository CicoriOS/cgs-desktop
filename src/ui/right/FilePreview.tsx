import { ArrowLeft, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FilePreview as Preview } from "../../core/types";
import { useT } from "../../i18n";
import { useActions } from "../client-context";
import { formatBytes } from "../format";
import { Markdown } from "../transcript/Markdown";
import type { DiffLine } from "../transcript/tools/diff";
import { DiffView } from "../transcript/tools/DiffView";
import { langOf } from "../transcript/tools/highlight";
import { relativeTo } from "./paths";

type Load = { path: string; preview?: Preview; error?: string };

/** One file of the workspace: source with line numbers and highlighting, Markdown rendered, images shown. */
export function FilePreview({ cwd, path, reload, onBack }: { cwd: string; path: string; reload: number; onBack: () => void }) {
  const t = useT();
  const actions = useActions();
  const [load, setLoad] = useState<Load>();
  const [source, setSource] = useState(false);
  useEffect(() => setSource(false), [path]);
  // A reload keeps the old content on screen until the new one arrives, so a file that changes under the reader does not flash.
  useEffect(() => {
    let live = true;
    actions.readFile(path).then(
      (preview) => live && setLoad({ path, preview }),
      (e) => live && setLoad({ path, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [actions, path, reload]);

  const shown = load?.path === path ? load : undefined;
  const text = shown?.preview?.kind === "text" ? shown.preview.text : undefined;
  const lines = useMemo<DiffLine[]>(() => (text === undefined ? [] : text.replace(/\n$/, "").split("\n").map((line, i) => ({ kind: "ctx", no: i + 1, text: line }))), [text]);
  const markdown = text !== undefined && /\.(md|markdown)$/i.test(path);
  const rel = relativeTo(cwd, path);

  return (
    <div className="fpv">
      <div className="file-head">
        <button type="button" className="icon small" title={t("right.back")} aria-label={t("right.back")} onClick={onBack}>
          <ArrowLeft className="i" />
        </button>
        <span className="file-path" title={path}>{rel}</span>
        {markdown && (
          <button type="button" className="file-mode" onClick={() => setSource((v) => !v)}>
            {source ? t("right.file.preview") : t("right.file.source")}
          </button>
        )}
        <button type="button" className="icon small" title={t("right.copyPath")} aria-label={t("right.copyPath")} onClick={() => void navigator.clipboard.writeText(path).then(() => actions.notify(t("right.copied")))}>
          <Copy className="i" />
        </button>
      </div>
      <div className="file-body">
        {!shown ? (
          <div className="right-note">{t("right.loading")}</div>
        ) : shown.error ? (
          <div className="right-note">{t("right.failed", { error: shown.error })}</div>
        ) : shown.preview?.kind === "image" ? (
          <img className="file-image" src={shown.preview.url} alt={rel} />
        ) : shown.preview?.kind === "binary" ? (
          <div className="right-note">{t("right.file.binary")}</div>
        ) : shown.preview?.kind === "large" ? (
          <div className="right-note">{t("right.file.large", { size: formatBytes(shown.preview.size) })}</div>
        ) : markdown && !source ? (
          <div className="file-md"><Markdown text={text ?? ""} /></div>
        ) : (
          <DiffView lines={lines} lang={langOf(path)} />
        )}
      </div>
    </div>
  );
}
