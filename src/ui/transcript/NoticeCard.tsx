import { BellRing, MessagesSquare } from "lucide-react";
import { useState } from "react";
import type { NoticeItem } from "../../core/types";
import { type MessageKey, useT } from "../../i18n";

const TITLES: Record<Exclude<NoticeItem["tone"], "rule">, MessageKey> = {
  ipc: "notice.ipc",
  todo: "notice.todo",
  reminder: "notice.reminder",
  notice: "notice.notice",
  interrupt: "notice.interrupt",
  other: "notice.other",
};

/**
 * Text meant for the model, not the user (a message from another model, a todo or system reminder, a rule injected after a rewind): a pale yellow card,
 * folded by default, so it is there to check but never competes with the conversation (ADR 0037).
 */
export function NoticeCard({ item }: { item: NoticeItem }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const title = item.tone === "rule" ? (item.names ? t("notice.rule", { names: item.names }) : t("notice.ruleAnon")) : t(TITLES[item.tone]);
  return (
    <details className="notice" data-tone={item.tone} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        {item.tone === "ipc" ? <MessagesSquare className="i" aria-hidden="true" /> : <BellRing className="i" aria-hidden="true" />}
        <span className="nt-title">{title}</span>
      </summary>
      {open && <div className="nt-body">{item.text}</div>}
    </details>
  );
}
