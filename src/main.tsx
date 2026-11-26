import { createRoot } from "react-dom/client";
import { createClient } from "./core/client";
import { bridgeHost, webSocketTransport } from "./core/transport";
import { getLocale } from "./i18n";
import { App } from "./ui/App";
import { ClientProvider } from "./ui/client-context";
import "./ui/styles/base.css";
import "./ui/styles/chat.css";
import "./ui/styles/dock.css";
import "./ui/styles/notice.css";

document.documentElement.lang = getLocale() === "zh" ? "zh-CN" : "en";
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const client = createClient(webSocketTransport(wsUrl), bridgeHost);

createRoot(document.getElementById("root")!).render(
  <ClientProvider client={client}>
    <App />
  </ClientProvider>,
);
