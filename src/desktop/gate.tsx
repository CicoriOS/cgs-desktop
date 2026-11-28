// The signed-out page (ADR 0046 §4): browser device login and email registration, in the app's own visual language.
// The window has no frame, so the page keeps the same draggable title bar and window buttons as the rest of the shell.
// Every login action goes through `window.cgsDesktop.host` (`login.*`, `register.*`); nothing is fetched from the page.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { type MessageKey, useT } from "../i18n";
import { WindowControls } from "../ui/WindowControls";
import { desktop } from "../ui/desktop";
import { desktopHost } from "./backend";
import { createLoginFlow, type LoginStep, type LoginView } from "./login-flow";
import type { DesktopHost, HostState } from "./protocol";
import "./login.css";

/** Sidecar error codes (`cgsconnect/local-channel.md` §6.1) to the page's wording. */
const ERROR_KEYS: Record<string, MessageKey> = {
  network: "login.err.network",
  timeout: "login.err.timeout",
  rate_limited: "login.err.rate_limited",
  server: "login.err.server",
  bad_response: "login.err.bad_response",
  rejected: "login.err.rejected",
  challenge_failed: "login.err.challenge_failed",
  denied: "login.err.denied",
  expired: "login.err.expired",
  cancelled: "login.err.cancelled",
  models: "login.err.models",
  registration_closed: "login.err.registration_closed",
  email_taken: "login.err.email_taken",
  email_invalid: "login.err.email_invalid",
  email_restricted: "login.err.email_restricted",
  cooldown: "login.err.cooldown",
  code_invalid: "login.err.code_invalid",
  too_many_attempts: "login.err.too_many_attempts",
  password_invalid: "login.err.password_invalid",
  send_failed: "login.err.send_failed",
  session_expired: "login.err.session_expired",
  internal: "login.err.internal",
  invalid_request: "login.err.invalid_request",
  account_created: "login.err.account_created",
  configure_failed: "login.err.configure_failed",
  link_down: "login.err.link_down",
  link_not_ready: "login.err.link_not_ready",
  call_failed: "login.err.call_failed",
  unknown_method: "login.err.unknown_method",
};

/** Local form validation, not a server code. */
const LOCAL_KEYS: Record<string, MessageKey> = {
  email_format: "login.err.email_format",
  password_format: "login.err.password_format",
  password_mismatch: "login.err.password_mismatch",
  code_format: "login.err.code_format",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** "15:00" until `at` (a Unix-ms instant), clamped at zero. */
function remaining(at: number | undefined, now: number): string {
  if (at === undefined) return "";
  const total = Math.max(0, Math.ceil((at - now) / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** A 500 ms clock while a countdown is on screen; stops with the screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function copy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).catch(() => {
    const area = document.createElement("textarea"); // the clipboard API needs a secure context
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  });
}

export function SignedOutGate({ state }: { state: HostState }) {
  const t = useT();
  const host = desktopHost();
  // A small window while the sign-in pages show; the app's size is restored when this unmounts (signed in, or the link went away).
  useEffect(() => {
    const win = desktop?.window;
    win?.setCompact(true);
    return () => win?.setCompact(false);
  }, []);
  return (
    <div className="host-screen" data-host-state="signed-out">
      <header className="host-titlebar">
        <span className="host-brand">CGS Desktop</span>
        <WindowControls />
      </header>
      <section className="host-card login-card">
        {host ? <LoginPage host={host} /> : <p className="host-body">{t("login.err.link_down")}</p>}
        <p className="host-detail login-version">{t("host.gate.cli", { cli: state.cli })}</p>
      </section>
    </div>
  );
}

function LoginPage({ host }: { host: DesktopHost }) {
  const t = useT();
  const flow = useMemo(() => createLoginFlow(host), [host]);
  useEffect(() => flow.attach(), [flow]);
  const view = useSyncExternalStore(flow.subscribe, flow.getState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const opened = useRef<string>(undefined);
  const now = useNow(view.screen === "waiting" || view.screen === "verify");

  // The browser link opens once per link, as the legacy login window did; the button and copy stay for another browser.
  useEffect(() => {
    const url = view.screen === "waiting" ? view.verificationUrl : undefined;
    if (!url || opened.current === url) return;
    opened.current = url;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [view.screen, view.verificationUrl]);

  useEffect(() => setFormError(undefined), [view.screen]);

  const errorText = (name: string | undefined): string => {
    if (!name) return "";
    const key = LOCAL_KEYS[name] ?? ERROR_KEYS[name];
    return key ? t(key, { code: name }) : t("login.err.unknown", { code: name });
  };

  const submitRegister = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address || address.length > 50 || !EMAIL.test(address)) return setFormError("email_format");
    if ([...password].length < 8 || [...password].length > 128) return setFormError("password_format");
    if (password !== confirm) return setFormError("password_mismatch");
    setFormError(undefined);
    void flow.requestCode(address);
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const digits = code.trim();
    if (!/^\d{6}$/.test(digits)) return setFormError("code_format");
    setFormError(undefined);
    void flow.completeRegistration(digits, password);
  };

  const copyLink = async () => {
    if (!view.verificationUrl) return;
    await copy(view.verificationUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (view.screen === "idle") {
    return (
      <>
        <h1 className="host-title login-hero">{t("login.title")}</h1>
        <p className="host-body">{t("login.lead")}</p>
        <div className="login-actions">
          <button type="button" className="login-btn primary" onClick={() => void flow.startLogin()}>
            {t("login.signIn")}
          </button>
          <button type="button" className="login-btn secondary" onClick={() => flow.showRegister()}>
            {t("login.register")}
          </button>
        </div>
      </>
    );
  }

  if (view.screen === "progress") {
    const steps: LoginStep[] = view.step === "registering" ? ["registering"] : view.flow === "register" ? ["creating", "solving", "sending"] : ["creating", "solving"];
    const active = steps.indexOf(view.step ?? "creating");
    return (
      <>
        <h1 className="host-title">{view.step === "registering" ? t("login.verify.registering") : t("login.progress.title")}</h1>
        <ol className="login-steps">
          {steps.map((step, index) => (
            <li key={step} data-state={index < active ? "done" : index === active ? "active" : "pending"}>
              <i aria-hidden="true" />
              <span>{t(`login.step.${step}` as MessageKey)}</span>
            </li>
          ))}
        </ol>
        <div className="host-spinner" aria-hidden="true" />
        {view.flow === "login" ? (
          <button type="button" className="login-btn ghost" onClick={() => void flow.cancelLogin()}>
            {t("common.cancel")}
          </button>
        ) : null}
      </>
    );
  }

  if (view.screen === "waiting") {
    return (
      <>
        <h1 className="host-title">{t("login.waiting.title")}</h1>
        <p className="host-body">{t("login.waiting.body")}</p>
        <div className="login-linkbox">
          <span>{t("login.waiting.link")}</span>
          <code>{view.verificationUrl}</code>
        </div>
        <div className="login-row">
          <button type="button" className="login-btn primary compact" onClick={() => view.verificationUrl && window.open(view.verificationUrl, "_blank", "noopener,noreferrer")}>
            {t("login.waiting.open")}
          </button>
          <button type="button" className="login-btn secondary compact" onClick={() => void copyLink()}>
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
        <p className="login-wait" role="status">
          <span className="login-pulse" aria-hidden="true" />
          {t("login.waiting.status")}
          {view.expiresAt !== undefined ? <span className="login-remaining">· {t("login.waiting.remaining", { time: remaining(view.expiresAt, now) })}</span> : null}
        </p>
        <button type="button" className="login-btn ghost" onClick={() => void flow.cancelLogin()}>
          {t("common.cancel")}
        </button>
      </>
    );
  }

  if (view.screen === "register") {
    return (
      <>
        <h1 className="host-title">{t("login.register.title")}</h1>
        <p className="host-body">{t("login.register.body")}</p>
        <form className="login-form" noValidate onSubmit={submitRegister}>
          <label className="login-field">
            <span>{t("login.field.email")}</span>
            <input
              type="email"
              value={email}
              maxLength={50}
              autoComplete="email"
              spellCheck={false}
              autoFocus
              onChange={(event) => {
                setEmail(event.target.value);
                setFormError(undefined);
                flow.clearError();
              }}
            />
          </label>
          <label className="login-field">
            <span>{t("login.field.password")}</span>
            <input
              type="password"
              value={password}
              maxLength={128}
              autoComplete="new-password"
              placeholder={t("login.field.passwordHint")}
              onChange={(event) => {
                setPassword(event.target.value);
                setFormError(undefined);
                flow.clearError();
              }}
            />
          </label>
          <label className="login-field">
            <span>{t("login.field.confirm")}</span>
            <input
              type="password"
              value={confirm}
              maxLength={128}
              autoComplete="new-password"
              onChange={(event) => {
                setConfirm(event.target.value);
                setFormError(undefined);
                flow.clearError();
              }}
            />
          </label>
          {(formError ?? view.error) && <p className="login-error" role="alert">{errorText(formError ?? view.error)}</p>}
          <button type="submit" className="login-btn primary">{t("login.register.submit")}</button>
        </form>
        <button type="button" className="login-btn ghost" onClick={() => flow.backToIdle()}>
          {t("login.register.back")}
        </button>
      </>
    );
  }

  if (view.screen === "verify") {
    const resendIn = view.resendAt !== undefined ? Math.max(0, Math.ceil((view.resendAt - now) / 1000)) : 0;
    return (
      <>
        <h1 className="host-title">{t("login.verify.title")}</h1>
        <p className="host-body">{t("login.verify.body", { email: view.email ?? "", time: remaining(view.expiresAt, now) })}</p>
        <form className="login-form" noValidate onSubmit={submitCode}>
          <input
            className="login-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            aria-label={t("login.verify.code")}
            spellCheck={false}
            autoFocus
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, ""));
              setFormError(undefined);
              flow.clearError();
            }}
          />
          {(formError ?? view.error) && <p className="login-error" role="alert">{errorText(formError ?? view.error)}</p>}
          <button type="submit" className="login-btn primary">{t("login.verify.submit")}</button>
        </form>
        <div className="login-row">
          <button type="button" className="login-btn secondary compact" disabled={resendIn > 0} onClick={() => void flow.resendCode()}>
            {resendIn > 0 ? t("login.verify.resendIn", { seconds: resendIn }) : t("login.verify.resend")}
          </button>
          <button type="button" className="login-btn secondary compact" onClick={() => flow.backToRegister()}>
            {t("login.verify.back")}
          </button>
        </div>
      </>
    );
  }

  if (view.screen === "done") {
    return (
      <>
        <h1 className="host-title">{t("login.done.title")}</h1>
        {view.username ? <p className="host-body">{t("login.done.account", { name: view.username })}</p> : null}
        <p className="host-body">{t("login.done.body")}</p>
        <div className="host-spinner" aria-hidden="true" />
      </>
    );
  }

  // error
  return (
    <>
      <h1 className="host-title">{t("login.error.title")}</h1>
      <p className="login-error" role="alert">{errorText(view.error)}</p>
      <div className="login-row">
        <button type="button" className="login-btn primary compact" onClick={() => (view.flow === "register" && view.error !== "account_created" ? flow.showRegister() : void flow.startLogin())}>
          {t("login.retry")}
        </button>
        <button type="button" className="login-btn secondary compact" onClick={() => flow.backToIdle()}>
          {t("login.back")}
        </button>
      </div>
    </>
  );
}
