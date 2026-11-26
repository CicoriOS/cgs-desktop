import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createClient } from "../core/client";
import type { Client } from "../core/types";
import { useT } from "../i18n";
import { App } from "../ui/App";
import { ClientProvider } from "../ui/client-context";
import { RelayConnection } from "./connection";
import { StateScreen } from "./screens";

/** The connect page for one device. The controller owns the link; this view only renders its state and forwards user intent. */
export function ConnectView({ device }: { device: string }) {
  const t = useT();
  const relay = useMemo(() => new RelayConnection(device), [device]);
  const state = useSyncExternalStore(relay.subscribe, relay.getSnapshot);
  const [client, setClient] = useState<Client>();
  const live = state.phase === "ready" || state.phase === "readonly";

  useEffect(() => {
    relay.start();
    return () => relay.close();
  }, [relay]);

  // The client lives while the link is up: created on ready, kept across ready -> readonly, dropped on any other phase
  // so that the next ready builds a fresh one.
  useEffect(() => {
    if (!live) return;
    const c = createClient(relay.transport, relay.host);
    setClient(c);
    return () => {
      c.close();
      setClient(undefined);
    };
  }, [live, relay]);

  if (live && client) {
    const readOnly = state.phase === "readonly";
    return (
      <ClientProvider client={client} readOnly={readOnly}>
        <div className="connect-shell">
          {readOnly && (
            <div className="connect-banner" role="status">
              <span>{state.by ? t("connect.readonly.bannerBy", { by: state.by }) : t("connect.readonly.banner")}</span>
              <button type="button" onClick={() => relay.takeover()}>
                {t("connect.readonly.takeover")}
              </button>
            </div>
          )}
          <div className="connect-app">
            <App />
          </div>
        </div>
      </ClientProvider>
    );
  }

  return <StateScreen state={state} relay={relay} />;
}
