import { ArrowLeft, ChevronLeft, ExternalLink, Search, UserRound } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { SettingsApi } from "../../core/settings";
import { useT } from "../../i18n";
import { Avatar } from "../AccountFooter";
import { useActions, useClientState } from "../client-context";
import { desktop } from "../desktop";
import { cx } from "../format";
import { isMobile } from "../viewport";
import { WindowControls } from "../WindowControls";
import { SettingRow } from "./controls";
import { AgentsPanel } from "./AgentsPanel";
import { DevicePanel } from "./DevicePanel";
import { ProvidersPreview } from "./ProvidersPreview";
import type { NativeProvider, PreviewSignIns } from "../provider-preview";
import { UsagePanel } from "./UsagePanel";
import type { Hit, Page, PageId, Row, Section, Value } from "./schema";
import { defaultValues, GROUPS, PAGES, searchSettings } from "./schema";

/** Full-screen settings with cross-page search. Custom panels use host capabilities; schema-based controls are previews. */
export function SettingsPage({ onClose, profileUrl, api, previewSignIns, onPreviewSignIn }: { onClose: () => void; profileUrl?: string; api?: SettingsApi; previewSignIns: PreviewSignIns; onPreviewSignIn: (id: NativeProvider["id"]) => void }) {
  const t = useT();
  const actions = useActions();
  const account = useClientState((s) => s.account);
  const [pageId, setPageId] = useState<PageId>("general");
  const [query, setQuery] = useState("");
  const [values, setValues] = useState(defaultValues);
  const [navOpen, setNavOpen] = useState(isMobile); // on a narrow screen the list and the page take turns
  const back = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const page = PAGES.find((p) => p.id === pageId);
  const hits = searching ? searchSettings(query, t) : [];

  useLayoutEffect(() => {
    back.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [pageId, query]);

  const go = (id: PageId) => {
    setPageId(id);
    setQuery("");
    setNavOpen(false);
    if (isMobile()) requestAnimationFrame(() => scroll.current?.focus());
  };
  const press = () => actions.notify(t("set.dummy"));
  const renderRow = (row: Row) => <SettingRow key={row.id} row={row} value={values[row.id]} onChange={(v: Value) => setValues((s) => ({ ...s, [row.id]: v }))} onPress={press} />;
  const renderSection = (section: Section, i: number) => (
    <section key={section.title ?? i} className="set-section">
      {section.title && <h3 className="set-sec">{t(section.title)}</h3>}
      <div className="set-rows">{section.rows.map(renderRow)}</div>
    </section>
  );

  const byPage = new Map<Page, Hit[]>();
  for (const hit of hits) {
    const list = byPage.get(hit.page);
    if (list) list.push(hit);
    else byPage.set(hit.page, [hit]);
  }

  return (
    <div id="settings" className={cx(navOpen && "nav-open", searching && "searching")} role="dialog" aria-modal="true" aria-label={t("set.title")}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
        e.stopPropagation();
        if (query) setQuery("");
        else onClose();
      }}>
      <div className="set-top">
        <button type="button" className="set-menu icon" aria-label={t("set.nav")} onClick={() => {
          setNavOpen(true);
          requestAnimationFrame(() => back.current?.focus());
        }}>
          <ChevronLeft className="i" />
        </button>
        <span className="grow" />
        <WindowControls />
      </div>
      <nav id="settings-nav" aria-label={t("set.nav")}>
        <button ref={back} type="button" className="set-back" onClick={onClose}>
          <ArrowLeft className="i" />
          {t("set.back")}
        </button>
        <label className="set-search">
          <Search className="i" />
          <input value={query} placeholder={t("set.search")} aria-label={t("set.search")} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="set-nav-list">
          <div className="set-nav-head">{t("set.profile")}</div>
          {profileUrl ? (
            <a className="set-nav-item set-profile" href={profileUrl} target={desktop ? "_blank" : undefined} rel={desktop ? "noopener noreferrer" : undefined} aria-label={t("set.ui.openProfile")}>
              {account ? <Avatar name={account.username} url={account.avatarUrl} /> : <UserRound className="i" />}
              <span>{account?.username ?? t("set.ui.openProfile")}</span>
              <ExternalLink className="i" />
            </a>
          ) : (
            <div className="set-nav-item set-profile" title={t("set.ui.noSite")} aria-disabled="true">
              {account ? <Avatar name={account.username} url={account.avatarUrl} /> : <UserRound className="i" />}
              <span>{account?.username ?? t("set.ui.noSite")}</span>
            </div>
          )}
          {GROUPS.map((group) => (
            <Fragment key={group}>
              <div className="set-nav-head">{t(`set.group.${group}`)}</div>
              {PAGES.filter((p) => p.group === group).map((p) => (
                <button key={p.id} type="button" className="set-nav-item" aria-current={!searching && pageId === p.id ? "page" : undefined} onClick={() => go(p.id)}>
                  <p.icon className="i" />
                  <span>{t(`set.page.${p.id}`)}</span>
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      </nav>
      <div id="settings-main">
        <div className="set-scroll" ref={scroll} tabIndex={-1}>
          <div className="set-page">
            <h2 className="set-title">{searching ? t("set.search") : page && t(`set.page.${page.id}`)}</h2>
            {!searching && page?.keywords && api?.preview && <p className="set-note">{t("set.ui.demoNotice")}</p>}
            {searching ? (
              hits.length === 0 ? (
                <div className="muted" role="status">{t("set.noMatch", { query: query.trim() })}</div>
              ) : Array.from(byPage, ([p, list]) => (
                <section key={p.id} className="set-section">
                  <h3 className="set-sec">
                    <button type="button" onClick={() => go(p.id)}>{t(`set.page.${p.id}`)}</button>
                  </h3>
                  {list.some(({ row }) => row) && <div className="set-rows">{list.map(({ row }) => row && renderRow(row))}</div>}
                </section>
              ))
            ) : page && (
              <>
                {page.id === "models" && api?.preview && <ProvidersPreview signIns={previewSignIns} onSignIn={onPreviewSignIn} />}
                {page.id === "agents" && <AgentsPanel api={api?.agents} />}
                {!!page.sections.length && <p className="set-note">{t("set.dummyNote")}</p>}
                {page.sections.map(renderSection)}
                {page.id === "usage" && <UsagePanel load={api?.usage} />}
                {page.id === "hosts" && <DevicePanel api={api?.device} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
