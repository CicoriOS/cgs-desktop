import { useEffect, useRef, useState } from "react";
import { useActions } from "./client-context";
import { cx } from "./format";
import { FolderIcon } from "./icons";
import { useT } from "../i18n";

/** Spotlight-style box that suggests directories while an absolute path is typed. */
export function WorkspaceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  const [value, setValue] = useState("/");
  const [entries, setEntries] = useState<string[]>([]);
  const [exists, setExists] = useState(false);
  const [sel, setSel] = useState(-1);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  const refresh = async (typed: string) => {
    const mine = ++seq.current;
    let r: { exists: boolean; entries: string[] } = { exists: false, entries: [] };
    try {
      r = await actions.completePath(typed);
    } catch {
      /* keep an empty list */
    }
    if (mine !== seq.current) return;
    setEntries(r.entries);
    setExists(r.exists);
    setSel(-1);
  };
  useEffect(() => void refresh("/"), []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (p: string) => {
    const cwd = p.trim().replace(/\/+$/, "") || "/";
    if (!cwd.startsWith("/")) return;
    onClose();
    void actions.addWorkspace(cwd);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const n = entries.length;
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      const next = e.key === "ArrowDown" ? (sel + 1) % n : sel <= 0 ? n - 1 : sel - 1;
      setSel(next);
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Tab") {
      e.preventDefault();
      const target = entries[Math.max(0, sel)];
      if (target) {
        setValue(`${target}/`);
        void refresh(`${target}/`);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(sel >= 0 ? (entries[sel] ?? value) : value);
    }
  };

  const hint = !value.startsWith("/") ? t("ws.hint.abs") : sel >= 0 ? t("ws.hint.pick") : exists ? t("ws.hint.here") : t("ws.hint.create");
  return (
    <div id="ws-dialog" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-card" role="dialog" aria-label={t("ws.aria")}>
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={t("ws.placeholder")}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            void refresh(e.target.value);
          }}
          onKeyDown={onKey}
        />
        <div id="ws-list" ref={list}>
          {entries.map((p, i) => (
            <div key={p} className={cx("ws-row", i === sel && "sel")} onClick={() => open(p)}>
              <FolderIcon />
              <span className="p">{p}</span>
            </div>
          ))}
        </div>
        <div id="ws-hint">{hint}</div>
      </div>
    </div>
  );
}
