import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "./core/client";
import { bridgeHost, webSocketTransport } from "./core/transport";
import type { HostApi, RpcTransport } from "./core/types";
import type { DesktopHost } from "./desktop/protocol";
import { ClosePrompt } from "./desktop/close-prompt";
import { getLocale } from "./i18n";
import { App } from "./ui/App";
import { ClientProvider } from "./ui/client-context";
import { desktop } from "./ui/desktop";
import "./ui/styles/base.css";
import "./ui/styles/chat.css";
import "./ui/styles/dock.css";
import "./ui/styles/notice.css";
import "./ui/styles/right.css";
import "./ui/styles/settings.css";
import "./ui/styles/desktop.css";

document.documentElement.lang = getLocale() === "zh" ? "zh-CN" : "en";
if (desktop) document.documentElement.dataset.shell = "desktop";
if (desktop?.glass) document.documentElement.dataset.glass = "";

type Connect = (childId: string) => RpcTransport;
type Backend = { kind: "web"; connect: Connect; host: HostApi } | { kind: "desktop"; connect: Connect; host: HostApi; link: DesktopHost };

/**
 * Three backends, in order: `?demo` (in-memory sessions, the desktop dev shell's default), the desktop sidecar
 * (`window.cgsDesktop.host`, ADR 0046), and the dev bridge over WebSocket.
 */
async function backend(): Promise<Backend> {
  if (new URLSearchParams(location.search).has("demo")) {
    // Loaded only on request: a static import would ship the demo conversations in the PWA.
    const { createDemoBackend } = await import("./demo/backend");
    return { kind: "web", ...createDemoBackend() };
  }
  const link = desktop?.host;
  if (link) {
    const { createDesktopBackend } = await import("./desktop/backend");
    return { kind: "desktop", link, ...createDesktopBackend(link) };
  }
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  return { kind: "web", connect: webSocketTransport(wsUrl), host: bridgeHost };
}

function AppRoot({ connect, host, profileUrl }: { connect: Connect; host: HostApi; profileUrl?: string }) {
  const client = useMemo(() => createClient(connect, host), [connect, host]);
  // The desktop shell unmounts the app while the link is down (startup/link page): its polling must stop with it.
  useEffect(() => () => client.close(), [client]);
  return (
    <ClientProvider client={client}>
      <App profileUrl={profileUrl} settingsApi={host.settings} />
    </ClientProvider>
  );
}

const resolved = await backend();
const server = import.meta.env.VITE_CGS_BASE_URL;
const profileUrl = /^https?:\/\//i.test(server ?? "") && URL.canParse(server) ? new URL("/profile", server).href : undefined;
const root = createRoot(document.getElementById("root")!);
// The element is not mounted here; the desktop shell mounts it only in the `ready` phase (ADR 0046 §1).
const app = <AppRoot connect={resolved.connect} host={resolved.host} profileUrl={profileUrl} />;

// The window close prompt exists in every desktop phase, including the startup pages; it renders nothing in a browser.
if (resolved.kind === "desktop") {
  // Only the desktop build downloads the startup/link pages; the web client and the demo never show them.
  const { DesktopShell } = await import("./desktop/state");
  root.render(
    <>
      <DesktopShell host={resolved.link} app={app} />
      <ClosePrompt />
    </>,
  );
} else {
  root.render(
    <>
      {app}
      <ClosePrompt />
    </>,
  );
}
