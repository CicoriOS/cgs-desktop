import { createRoot } from "react-dom/client";
import { getLocale } from "../i18n";
import "../ui/styles/base.css";
import "../ui/styles/chat.css";
import "../ui/styles/dock.css";
import "../ui/styles/notice.css";
import "../ui/styles/settings.css";
import "./connect.css";
import { ConnectView } from "./ConnectView";
import { MissingPage } from "./screens";
import { trackVisualViewport } from "./viewport";

trackVisualViewport();
document.documentElement.lang = getLocale() === "zh" ? "zh-CN" : "en";

// `/connect?device=<client id>` (ADR 0036 §3). Without the parameter nothing is constructed: the plain page says how to get here.
const device = new URLSearchParams(location.search).get("device")?.trim() ?? "";

createRoot(document.getElementById("root")!).render(device ? <ConnectView device={device} /> : <MissingPage />);
