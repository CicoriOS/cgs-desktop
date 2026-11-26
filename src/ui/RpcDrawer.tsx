import { useSyncExternalStore, useState } from "react";
import { useClient } from "./client-context";
import { CloseIcon } from "./icons";
import { useT } from "../i18n";

const VISIBLE_ROWS = 1000;
const PREVIEW_CHARS = 160;

function Row({ dir, text }: { dir: "in" | "out"; text: string }) {
  const [open, setOpen] = useState(false);
  let obj: { type?: string; command?: string; success?: boolean } | undefined;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = undefined;
  }
  const label = obj ? `${obj.type}${obj.command ? `:${obj.command}` : ""}` : "(not json)";
  return (
    <details className={`${dir}${obj?.success === false ? " err" : ""}`} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="t">{`${dir === "out" ? "→" : "←"} ${label}`}</span> <span className="p">{text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}</span>
      </summary>
      {open && <pre>{obj ? JSON.stringify(obj, null, 2) : text}</pre>}
    </details>
  );
}

/** Raw JSONL frames in both directions, with a box to send a hand-written one. Debug aid. */
export function RpcDrawer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const client = useClient();
  const frames = useSyncExternalStore(client.raw.subscribe, () => client.raw.frames().length === 0 ? EMPTY : client.raw.frames());
  const [stream, setStream] = useState(false);
  const [raw, setRaw] = useState("");
  const rows = frames.filter((f) => stream || !f.text.startsWith('{"type":"message_update"')).slice(-VISIBLE_ROWS);
  return (
    <section id="rpc">
      <div className="rpc-bar">
        <b>RPC</b>
        <span className="muted">{t("rpc.frames", { n: frames.length })}</span>
        <label>
          <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> {t("rpc.showUpdates")}
        </label>
        <button type="button" onClick={() => client.actions.clearRaw()}>
          {t("common.clear")}
        </button>
        <span className="grow" />
        <button type="button" className="icon small" onClick={onClose} title={t("common.close")}>
          <CloseIcon />
        </button>
      </div>
      <div id="rpc-log">
        {rows.map((f, i) => (
          <Row key={`${frames.length - rows.length + i}`} dir={f.dir} text={f.text} />
        ))}
      </div>
      <form
        id="rpc-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!raw.trim()) return;
          client.actions.sendRaw(raw.trim());
          setRaw("");
        }}
      >
        <input placeholder={t("rpc.placeholder")} autoComplete="off" value={raw} onChange={(e) => setRaw(e.target.value)} />
      </form>
    </section>
  );
}

const EMPTY: readonly { dir: "in" | "out"; text: string }[] = [];
