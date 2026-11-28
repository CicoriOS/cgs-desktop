// Startup and link pages (ADR 0046 §1, §3). The app renders only once the sidecar reports `ready`; every other phase gets a
// page that says what is wrong. The web build and `?demo` never import this module (src/main.tsx loads it dynamically).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { type MessageKey, useT } from "../i18n";
import { desktop } from "../ui/desktop";
import { WindowControls } from "../ui/WindowControls";
import { SignedOutGate } from "./gate";
import { type CliSyncState, type DesktopHost, type HostLinkDetail, type HostLinkStatus, type HostState, isHostState } from "./protocol";
import "./desktop-state.css";

interface Link {
  status: HostLinkStatus;
  detail: HostLinkDetail;
}

/** Failures that need the user to install or update the CLI, not a retry. */
const INSTALL_FAILURES: Record<string, true> = { cgs_not_found: true, sidecar_missing: true, cgs_sidecar_invalid: true, spawn_failed: true };

const ERROR_KEYS: Record<string, MessageKey> = {
  cgs_not_found: "host.err.cgs_not_found",
  cgs_sidecar_invalid: "host.err.cgs_sidecar_invalid",
  sidecar_missing: "host.err.sidecar_missing",
  spawn_failed: "host.err.spawn_failed",
  sidecar_exited: "host.err.sidecar_exited",
  bad_handshake: "host.err.bad_handshake",
  handshake_timeout: "host.err.handshake_timeout",
  link_down: "host.err.link_down",
  link_not_ready: "host.err.link_not_ready",
  call_failed: "host.err.call_failed",
  configure_failed: "host.err.configure_failed",
  protocol_mismatch: "host.err.protocol_mismatch",
  cgs_too_new: "host.err.cgs_too_new",
  bun_missing: "host.err.bun_missing",
  bun_install_failed: "host.err.bun_install_failed",
  install_failed: "host.err.install_failed",
  offline: "host.err.offline",
  cgs_not_managed: "host.err.cgs_not_managed",
  version_unreadable: "host.err.version_unreadable",
  install_unverified: "host.err.install_unverified",
  restart_cancelled: "host.err.restart_cancelled",
  sync_failed: "host.err.sync_failed",
};

/** The shell's CLI sync state (ADR 0046 §3); undefined in a browser, where there is no sync. */
function useCliSync(): CliSyncState | undefined {
  const shell = desktop?.shell;
  const [sync, setSync] = useState<CliSyncState>();
  useEffect(() => {
    if (!shell) return;
    return shell.onSync(setSync);
  }, [shell]);
  return sync;
}

/** `app` is the whole client; it is only mounted in the `ready` phase. */
export function DesktopShell({ host, app }: { host: DesktopHost; app: ReactNode }) {
  const t = useT();
  const [link, setLink] = useState<Link>({ status: "connecting", detail: {} });
  const [state, setState] = useState<HostState | undefined>();
  const [callError, setCallError] = useState<string | undefined>();
  const sync = useCliSync();
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const stopStatus = host.onStatus((status, detail) => setLink({ status, detail: detail ?? {} }));
    const stopEvents = host.onEvent((name, data) => {
      if (name === "state" && isHostState(data)) setState(data);
    });
    return () => {
      stopStatus();
      stopEvents();
    };
  }, [host]);

  // Every time the link becomes ready (first start, or after a sidecar restart) the phase is read again. `event state` keeps it fresh.
  useEffect(() => {
    if (link.status !== "ready") {
      setState(undefined);
      setCallError(undefined);
      return;
    }
    let live = true;
    setCallError(undefined);
    host.call<HostState>("state").then(
      (next) => {
        if (live) setState(next);
      },
      (error) => {
        if (live) setCallError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [host, link.status]);

  const errorText = (code: string | undefined): string => {
    if (!code) return "";
    const key = ERROR_KEYS[code];
    return key ? t(key) : code;
  };

  // Starting up is silent: the window stays hidden (the shell shows it when asked) through every wait that needs nothing from the
  // user: CLI check and install, connecting, the first state. Once the window has been shown, later waits (a sidecar restart) do
  // show their page, because someone is looking.
  const { node, quiet } = pick();
  useEffect(() => {
    if (quiet || revealed) return;
    setRevealed(true);
    desktop?.window.reveal();
  }, [quiet, revealed]);
  return quiet && !revealed ? null : node;

  function pick(): { node: ReactNode; quiet: boolean } {
    const waiting = (title: string, body: string): { node: ReactNode; quiet: boolean } => ({
      node: <Screen phase="starting" title={title} body={body} />,
      quiet: true,
    });
    const shown = (node: ReactNode): { node: ReactNode; quiet: boolean } => ({ node, quiet: false });

    // The sidecar only starts after the CLI sync; until then (and on its failures) the sync page is the whole story.
    if (sync && sync.phase !== "ready") return { node: <SyncPage state={sync} />, quiet: sync.phase === "checking" || sync.phase === "installing" };

    if (link.status === "upgrade") {
      const got = link.detail.protocol;
      return shown(<Screen phase="upgrade" title={t("host.upgrade.title")} body={t("host.upgrade.body", { expected: 1, got: got ?? "?" })} detail={link.detail.cli} />);
    }

    if (link.status === "down") {
      const error = link.detail.error;
      const needsInstall = error !== undefined && Object.hasOwn(INSTALL_FAILURES, error);
      const screen = (
        <Screen
          phase={needsInstall ? "missing" : "down"}
          title={t(needsInstall ? "host.missing.title" : "host.down.title")}
          body={t(needsInstall ? "host.missing.body" : "host.down.body")}
          detail={error ? errorText(error) : undefined}
          log={link.detail.log}
        />
      );
      // A link that is only reconnecting heals itself; one that needs an install will not.
      return { node: screen, quiet: !needsInstall };
    }

    if (link.status === "connecting") return waiting(t("host.starting.title"), t("host.starting.body"));

    if (callError) {
      return shown(<Screen phase="error" title={t("host.error.title")} body={t("host.error.body")} detail={errorText(callError)} log={link.detail.log} />);
    }
    if (!state || state.phase === "starting") return waiting(t("host.starting.title"), t("host.starting.body"));
    if (state.phase === "error") {
      return shown(<Screen phase="error" title={t("host.error.title")} body={t("host.error.body")} detail={errorText(state.error)} log={link.detail.log} />);
    }
    if (state.phase === "signed-out") return shown(<SignedOutGate state={state} />);
    return shown(<>{app}</>);
  }
}

/** The CLI sync phases before the sidecar exists (ADR 0046 §3): checking, installing with streamed progress, refused, failed. */
function SyncPage({ state }: { state: CliSyncState }) {
  const t = useT();
  const shell = desktop?.shell;
  const retry = () => shell?.retry();
  const technical = [state.detail, state.log, state.shadowed?.length ? `other cgs: ${state.shadowed.join(", ")}` : undefined].filter(Boolean).join("\n");
  if (state.phase === "checking") {
    return <Screen phase="sync" busy title={t("host.sync.checking.title")} body={t("host.sync.checking.body")} />;
  }
  if (state.phase === "installing") {
    return <Screen phase="sync" busy title={t("host.sync.installing.title")} body={t("host.sync.installing.body")} progress={state.progress} />;
  }
  if (state.phase === "refused") {
    return (
      <Screen
        phase="sync"
        title={t("host.sync.refused.title")}
        body={t("host.sync.refused.body", { installed: state.version ?? "?" })}
        detail={state.code ? t(ERROR_KEYS[state.code] ?? "host.err.sync_failed") : undefined}
        log={technical || undefined}
      />
    );
  }
  const code = state.code ? ERROR_KEYS[state.code] : undefined;
  const body =
    state.code === "bun_missing"
      ? t("host.sync.bun.body", { version: state.bound ?? "?" })
      : state.code === "offline"
        ? t("host.sync.offline.body")
        : t("host.sync.error.body");
  return (
    <Screen
      phase="sync"
      title={t("host.sync.error.title")}
      body={body}
      detail={code ? t(code) : state.code}
      log={technical || undefined}
      onRetry={retry}
    />
  );
}

function Screen({ phase, title, body, detail, log, progress, onRetry, busy: busyOverride }: { phase: "starting" | "missing" | "upgrade" | "down" | "error" | "sync"; title: string; body?: string; detail?: string; log?: string; progress?: string[]; onRetry?: () => void; busy?: boolean }) {
  const t = useT();
  const busy = busyOverride ?? (phase === "starting" || phase === "down");
  return (
    <div className="host-screen" data-host-state={phase}>
      <header className="host-titlebar">
        <span className="host-brand">CGS Desktop</span>
        <WindowControls />
      </header>
      <section className={`host-card host-${phase}`} role={phase === "error" ? "alert" : "status"} aria-live="polite">
        <h1 className="host-title">{title}</h1>
        {body ? <p className="host-body">{body}</p> : null}
        {detail ? <p className="host-detail">{detail}</p> : null}
        {busy ? <div className="host-spinner" aria-hidden="true" /> : null}
        {progress?.length ? (
          <pre className="host-progress">{progress.join("\n")}</pre>
        ) : null}
        {onRetry ? (
          <button type="button" className="host-retry" onClick={onRetry}>
            {t("host.sync.retry")}
          </button>
        ) : null}
        {log ? (
          <details className="host-log" open={phase === "missing" || phase === "error" || phase === "sync"}>
            <summary>{t("host.log")}</summary>
            <pre>{log}</pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}
