import { Check, ExternalLink, KeyRound, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../../i18n";
import { UsageMeter } from "../UsageMeter";
import { OMP_PROVIDERS } from "../omp-providers";
import { NATIVE_PROVIDERS, type NativeProvider, type PreviewSignIns } from "../provider-preview";

interface Custom {
  name: string;
  api: string;
  model: string;
  logo?: string;
}

const PAGE_SIZE = 5;

/** An in-memory UI demo. Neither the account flow nor the form contacts a host. */
export function ProvidersPreview({ signIns, onSignIn }: { signIns: PreviewSignIns; onSignIn: (id: NativeProvider["id"]) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"native" | "custom">("native");
  const [auth, setAuth] = useState<NativeProvider>();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [preset, setPreset] = useState<(typeof OMP_PROVIDERS)[number]>();
  const search = query.trim().toLowerCase();
  const matches = OMP_PROVIDERS.filter(({ id, name }) => id.includes(search) || name.toLowerCase().includes(search));
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const [custom, setCustom] = useState<Custom[]>([]);
  const [status, setStatus] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setAuth(undefined);
    setKind("native");
    trigger.current?.focus();
  };

  return (
    <section className="set-card providers" aria-labelledby="providers-title">
      <header className="providers-head">
        <div>
          <h3 id="providers-title">{t("set.providers.title")}</h3>
          <p className="set-desc">{t("set.providers.desc")}</p>
        </div>
        <button ref={trigger} type="button" className={open ? "set-btn" : "set-btn primary"} aria-expanded={open} aria-controls="providers-add"
          onClick={() => open ? close() : setOpen(true)}>
          {open ? <X className="i" /> : <Plus className="i" />}
          {t(open ? "set.providers.close" : "set.providers.add")}
        </button>
      </header>
      <p className="providers-demo">{t("set.providers.demo")}</p>
      <div id="providers-add" hidden={!open}>
        {open && (
          <>
            <div className="set-tabs providers-tabs" role="group" aria-label={t("set.providers.add")}>
              <button type="button" aria-pressed={kind === "native"} onClick={() => setKind("native")}>{t("set.providers.catalog")}</button>
              <button type="button" aria-pressed={kind === "custom"} onClick={() => { setPreset(undefined); setKind("custom"); setAuth(undefined); }}>{t("set.providers.custom")}</button>
            </div>
            {kind === "native" ? (
              <div className="providers-choices">
                <input type="search" className="set-text" aria-label={t("set.providers.search")} placeholder={t("set.providers.search")} value={query} onChange={(event) => { setQuery(event.currentTarget.value); setPage(0); setAuth(undefined); }} />
                {!pages && <p className="set-desc" role="status">{t("set.providers.noMatches")}</p>}
                {matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((provider) => (
                  <button type="button" className="providers-choice" key={provider.id} aria-expanded={provider.native ? auth === provider.native : undefined} onClick={() => {
                    if (provider.native) setAuth(auth === provider.native ? undefined : provider.native);
                    else { setPreset(provider); setKind("custom"); setAuth(undefined); }
                  }}>
                    <span className="providers-brand">
                      {provider.logo ? <img src={`${import.meta.env.BASE_URL}${provider.logo}`} alt="" /> : <span className="provider-initials" aria-hidden="true">{provider.name.slice(0, 2).toUpperCase()}</span>}
                      {provider.name}
                    </span>
                    <span className="providers-login">{t(provider.native ? "set.providers.signIn" : "set.providers.add")}{provider.native && <ExternalLink className="i" />}</span>
                  </button>
                ))}
                {pages > 1 && <div className="providers-pagination">
                  <button type="button" className="set-btn" disabled={!page} onClick={() => { setPage(page - 1); setAuth(undefined); }}>{t("set.providers.prev")}</button>
                  <span aria-live="polite">{page + 1} / {pages}</span>
                  <button type="button" className="set-btn" disabled={page + 1 === pages} onClick={() => { setPage(page + 1); setAuth(undefined); }}>{t("set.providers.next")}</button>
                </div>}
                {auth && (
                  <div className="providers-auth">
                    <p>{t("set.providers.authorize", { name: auth.name })}</p>
                    <div className="set-actions">
                      <button type="button" className="set-btn primary" onClick={() => {
                        onSignIn(auth.id);
                        setStatus(t("set.providers.connected", { name: auth.name }));
                        close();
                      }}>{t("set.providers.confirm")}</button>
                      <button type="button" className="set-btn" onClick={() => setAuth(undefined)}>{t("set.providers.cancel")}</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <form className="providers-form" key={preset?.id ?? "custom"} onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                const name = String(fields.get("name") ?? "").trim();
                const model = String(fields.get("model") ?? "").trim();
                if (!name || !model) return;
                setCustom((previous) => [...previous, { name, model, api: String(fields.get("api")), logo: preset?.logo ?? (/\bgemini\b/i.test(name) ? "gemini-mark.svg" : undefined) }]);
                setStatus(t("set.providers.added", { name }));
                close();
              }}>
                <label>{t("set.providers.name")}<input className="set-text" name="name" required defaultValue={preset?.name} placeholder="Model Lab" /></label>
                <label>{t("set.providers.protocol")}
                  <select className="set-select" name="api">
                    <option>OpenAI Chat Completions</option>
                    <option>OpenAI Responses</option>
                    <option>Anthropic Messages</option>
                  </select>
                </label>
                <label className="provider-full">{t("set.providers.endpoint")}<input className="set-text" type="url" required placeholder="https://api.example.com/v1" /></label>
                <label>{t("set.providers.model")}<input className="set-text" name="model" required placeholder="example-model" /></label>
                <label>{t("set.providers.key")}<input className="set-text" type="password" autoComplete="off" placeholder={t("set.providers.keyHint")} /></label>
                <div className="set-actions provider-full">
                  <button type="submit" className="set-btn primary">{t("set.providers.save")}</button>
                  <button type="button" className="set-btn" onClick={close}>{t("set.providers.cancel")}</button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
      {status && <p className="providers-status" role="status"><Check className="i" />{status}</p>}
      <div className="providers-grid" role="group" aria-label={t("set.providers.native")}>
        {NATIVE_PROVIDERS.map(({ id, name, logo, plan, usage }) => (
          <div className="providers-account" data-provider={id} key={id}>
            <div className="providers-account-head">
              <b className="providers-brand"><img src={`${import.meta.env.BASE_URL}${logo}`} alt="" />{name}</b>
              <span className="providers-plan">{plan}</span>
            </div>
            <p className="set-desc">{t("set.providers.examples", { n: 1 + (signIns[id] ?? 0) })}</p>
            {usage.map((used, index) => {
              const label = t(index === 0 ? "set.providers.window5h" : "set.providers.window7d");
              return (
                <div className="providers-limit" key={label}>
                  <div><span>{label}</span><strong className="usage-value">{t("set.providers.remaining", { n: 100 - used })}</strong></div>
                  <UsageMeter used={used} label={`${name} · ${label}`} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {custom.length > 0 && (
        <div className="providers-custom">
          <h4>{t("set.providers.custom")}</h4>
          <ul>{custom.map(({ name, api, model, logo }, index) => (
            <li key={index}><span className="providers-brand">{logo ? <img src={`${import.meta.env.BASE_URL}${logo}`} alt="" /> : <KeyRound className="i" />}</span><div><b>{name}</b><p className="set-desc">{api} · {model}</p></div></li>
          ))}</ul>
        </div>
      )}
    </section>
  );
}
