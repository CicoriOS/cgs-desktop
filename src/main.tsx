import { createRoot } from "react-dom/client";
import { createClient } from "./core/client";
import { bridgeHost, webSocketTransport } from "./core/transport";
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

/** `?demo`: in-memory sessions instead of the bridge (the desktop dev shell opens the page this way). */
async function backend() {
  if (new URLSearchParams(location.search).has("demo")) {
    // Loaded only on request: a static import would ship the demo conversations in the PWA.
    const { createDemoBackend } = await import("./demo/backend");
    return createDemoBackend();
  }
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  return { connect: webSocketTransport(wsUrl), host: bridgeHost };
}

const { connect, host } = await backend();
const client = createClient(connect, host);
const server = import.meta.env.VITE_CGS_BASE_URL;
const profileUrl = /^https?:\/\//i.test(server ?? "") && URL.canParse(server) ? new URL("/profile", server).href : undefined;

createRoot(document.getElementById("root")!).render(
  <ClientProvider client={client}>
    <App profileUrl={profileUrl} settingsApi={host.settings} />
  </ClientProvider>,
);
