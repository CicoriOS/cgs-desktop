// The desktop backend (ADR 0046 §1): the same RelayMux the remote client uses, but over `window.cgsDesktop.host` instead of
// the relay socket. The mux sees `send`/`receive` exactly as it does on the web, so host calls and child streams behave the
// same in both products.
import { RelayMux } from "../connect/mux";
import type { HostApi, RpcTransport } from "../core/types";
import type { DesktopHost } from "./protocol";
import { createSettingsApi } from "./settings";
import { createWorkspaceApi } from "./workspace";

export interface DesktopBackend {
  connect: (childId: string) => RpcTransport;
  host: HostApi;
}

/** The shell's host link, when the page runs inside CGS Desktop. */
export function desktopHost(): DesktopHost | undefined {
  return typeof window === "undefined" ? undefined : window.cgsDesktop?.host;
}

export function createDesktopBackend(link: DesktopHost = requiredHost()): DesktopBackend {
  const mux = new RelayMux((message) => link.send(message));
  link.onMessage((message) => mux.receive(message));
  link.onStatus((status) => {
    // A lost link is not the end of this mux: it keeps streams alive so they reopen when the sidecar returns. A protocol
    // mismatch is final (no fallback, ADR 0041); the startup page replaces the app until the CLI is updated.
    if (status === "down" || status === "connecting") mux.linkLost();
    else if (status === "upgrade") mux.disconnect();
  });
  // The single composition point for the desktop host: the local-only capabilities attach here before the UI sees the
  // host (ADR 0046 §7). `workspace` needs the shell's file/Git bridge; `settings` needs the same sidecar link.
  const host: HostApi = mux.host;
  const workspace = createWorkspaceApi();
  if (workspace) host.workspace = workspace;
  const settings = createSettingsApi(link);
  if (settings) host.settings = settings;
  return { connect: mux.transport, host };
}

function requiredHost(): DesktopHost {
  const host = desktopHost();
  if (!host) throw new Error("window.cgsDesktop.host is not available");
  return host;
}
