import { useState } from "react";
import { useActions, useClientState, useReadOnly } from "./client-context";
import { FEATURES } from "./features";
import { ChatBubbleIcon, GaugeIcon, SidebarLeftIcon, SidebarRightIcon } from "./icons";
import { setLocale, useLocale, useT } from "../i18n";

/** Click the title to rename the session: Enter saves through omp's set_session_name, Esc cancels. omp never overwrites a name set this way. */
function Title() {
  const actions = useActions();
  const title = useClientState((s) => s.title);
  const readOnly = useReadOnly();
  const [draft, setDraft] = useState<string>();

  const finish = (save: boolean) => {
    const name = draft?.trim();
    setDraft(undefined);
    if (save && name && name !== title) void actions.renameSession(name);
  };
  if (readOnly) return <span id="title">{title}</span>;
  if (draft !== undefined) {
    return (
      <input
        className="title-edit"
        autoFocus
        maxLength={120}
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(true);
          else if (e.key === "Escape") finish(false);
        }}
      />
    );
  }
  return (
    <span id="title" onClick={() => title && setDraft(title)}>
      {title}
    </span>
  );
}

export function Topbar({ onToggleSide, onToggleRight, onToggleBtw, onToggleStats, inSession }: { onToggleSide: () => void; onToggleRight: () => void; onToggleBtw: () => void; onToggleStats: () => void; inSession: boolean }) {
  const t = useT();
  const locale = useLocale();
  return (
    <header id="topbar">
      <button type="button" className="icon" title={t("side.toggle")} onClick={onToggleSide}>
        <SidebarLeftIcon />
      </button>
      <Title />
      <span className="grow" />
      {inSession && (
        <>
          <button type="button" className="icon" title={t("stats.open")} onClick={onToggleStats}>
            <GaugeIcon />
          </button>
          <button type="button" className="icon" title={t("btw.open")} onClick={onToggleBtw}>
            <ChatBubbleIcon />
          </button>
        </>
      )}
      <button type="button" className="lang" title={t("lang.switch")} onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>
        {locale === "zh" ? "EN" : "中"}
      </button>
      {FEATURES.rightPanel && (
        <button type="button" className="icon" title={t("side.toggleRight")} onClick={onToggleRight}>
          <SidebarRightIcon />
        </button>
      )}
    </header>
  );
}
