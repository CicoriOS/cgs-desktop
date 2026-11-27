import { Bot, GitBranch, Globe, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelOption, Orchestration, RoleModel, SettingsApi } from "../../core/settings";
import { useT } from "../../i18n";
import { useReadOnly } from "../client-context";

function ModelChoices({ models, value }: { models: ModelOption[]; value: string }) {
  return <>
    {value && !models.some((model) => model.id === value) && <option value={value}>{value}</option>}
    {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
  </>;
}

function RoleFields({ name, role, models, required, onChange }: { name: string; role: RoleModel; models: ModelOption[]; required?: boolean; onChange: (role: RoleModel) => void }) {
  const t = useT();
  const levels = models.find((model) => model.id === role.model)?.thinking ?? [];
  return (
    <div className="orc-fields">
      <label>
        <span>{t("set.ui.model")}</span>
        <select className="set-select" aria-label={`${name} · ${t("set.ui.model")}`} value={role.model} onChange={(e) => {
          const model = e.target.value;
          const thinking = role.thinking;
          const allowed = model && (thinking === "auto" || (thinking && models.find((item) => item.id === model)?.thinking.includes(thinking)));
          onChange({ model, thinking: allowed ? thinking : "" });
        }}>
          <option value="" disabled={required}>{required ? "—" : t("set.ui.agentDefault")}</option>
          <ModelChoices models={models} value={role.model} />
        </select>
      </label>
      <label>
        <span>{t("set.sec.reasoning")}</span>
        <select className="set-select" aria-label={`${name} · ${t("set.sec.reasoning")}`} value={role.thinking} disabled={!role.model}
          onChange={(e) => {
            const selection = e.target.value;
            onChange({ ...role, thinking: selection === "auto" ? selection : levels.find((level) => level === selection) ?? "" });
          }}>
          <option value="">{t("set.opt.default")}</option>
          <option value="auto">{t("set.opt.auto")}</option>
          {role.thinking && role.thinking !== "auto" && !levels.includes(role.thinking) && <option value={role.thinking}>{role.thinking}</option>}
          {levels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
    </div>
  );
}

export function AgentsPanel({ api }: { api?: SettingsApi["agents"] }) {
  const t = useT();
  const readOnly = useReadOnly();
  const [state, setState] = useState<{ models: ModelOption[]; saved: Orchestration; defaults: Orchestration }>();
  const [draft, setDraft] = useState<Orchestration>();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "error" | "loadFailed">();

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.read().then(({ models, layout, defaults }) => {
      if (!active) return;
      setState({ models, saved: layout, defaults });
      setDraft(layout);
    }, () => { if (active) setMessage("loadFailed"); });
    return () => { active = false; };
  }, [api]);

  if (!api) return <p className="set-card muted">{t("set.ui.agentsUnavailable")}</p>;
  if (!state || !draft) return <p className="set-card muted" role="status">{t(message === "loadFailed" ? "set.ui.loadFailed" : "set.ui.loading")}</p>;
  const { models, saved, defaults } = state;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const edit = (layout: Orchestration) => { setDraft(layout); setMessage(undefined); };
  const mainName = t("set.ui.mainModel");
  const add = () => {
    const trimmed = name.trim();
    if (!/^[\w-]+$/.test(trimmed) || draft.agents.some((agent) => agent.name === trimmed)) {
      setNameError(true);
      return;
    }
    edit({ ...draft, agents: [...draft.agents, { name: trimmed, model: "", thinking: "" }] });
    setName("");
    setNameError(false);
  };
  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const layout = await api.save(draft);
      setState({ ...state, saved: layout });
      setDraft(layout);
      setMessage("saved");
    } catch {
      setMessage("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-section">
      <h3 className="set-sec">{t("set.ui.orchestration")}</h3>
      <p className="set-note">{t("set.ui.agentHelp")}</p>
      <fieldset className="orc-tree" disabled={busy || readOnly} aria-label={t("set.ui.orchestration")}>
        <div className="orc-node orc-main">
          <div className="orc-head"><GitBranch className="i" /><b>{mainName}</b></div>
          <RoleFields name={mainName} role={draft.main} models={models} required onChange={(main) => edit({ ...draft, main })} />
        </div>
        <ul className="orc-branches">
          {draft.agents.map((agent, index) => (
            <li key={agent.name} className="orc-node">
              <div className="orc-head">
                <Bot className="i" /><b>{agent.name}</b>
                {!agent.builtIn && (
                  <button type="button" className="orc-remove icon" aria-label={t("set.ui.removeRole", { name: agent.name })}
                    onClick={() => edit({ ...draft, agents: draft.agents.filter((a) => a !== agent) })}><X className="i" /></button>
                )}
              </div>
              <RoleFields name={agent.name} role={agent} models={models}
                onChange={(role) => edit({ ...draft, agents: draft.agents.with(index, { ...agent, ...role }) })} />
            </li>
          ))}
          <li className="orc-node">
            <div className="orc-head"><Globe className="i" /><b>{t("set.ui.webSearch")}</b></div>
            <p className="set-desc">{t("set.ui.webHelp")}</p>
            <select className="set-select orc-web" aria-label={t("set.ui.webSearch")} value={draft.web} onChange={(e) => edit({ ...draft, web: e.target.value })}>
              <option value="">{t("set.ui.webDefault")}</option>
              <ModelChoices models={models} value={draft.web} />
            </select>
          </li>
          <li className="orc-node">
            <form className="orc-add" onSubmit={(e) => { e.preventDefault(); if (!busy && !readOnly) add(); }}>
              <input className="set-text" aria-label={t("set.ui.roleName")} placeholder={t("set.ui.roleName")} value={name}
                aria-invalid={nameError || undefined} onChange={(e) => { setName(e.target.value); setNameError(false); }} />
              <button className="set-btn" type="submit" disabled={!name.trim()}><Plus className="i" />{t("set.opt.add")}</button>
            </form>
            {nameError && <p className="set-desc" role="alert">{t("set.ui.roleNameError")}</p>}
          </li>
        </ul>
        <div className="set-actions">
          <button className="set-btn" type="button" onClick={() => edit(defaults)}>{t("set.ui.restore")}</button>
          <span className="grow" />
          <button className="set-btn" type="button" disabled={!dirty} onClick={() => edit(saved)}>{t("set.ui.discard")}</button>
          <button className="set-btn primary" type="button" disabled={!dirty || !draft.main.model} onClick={() => void save()}>{t("set.ui.save")}</button>
        </div>
      </fieldset>
      <p className="set-desc" role="status">{message === "saved" ? t("set.ui.saved") : message === "error" ? t("set.ui.actionFailed") : busy ? t("set.ui.saving") : dirty ? t("set.ui.unsaved") : ""}</p>
    </section>
  );
}
