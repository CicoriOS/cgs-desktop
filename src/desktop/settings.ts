// The settings page over the real device: the sidecar's `settings.*` calls (cgsconnect/local-channel.md §6.2) plus the
// shell's updater for anything that updates the app itself. The demo fakes the same interface in src/demo/settings.ts,
// so the settings UI never branches on host.
import type { DeviceSettings, ModelOption, Orchestration, SettingsApi, UsageReport } from "../core/settings";
import type { DesktopHost } from "./protocol";

/** What the shell reports while it checks, downloads or installs (ADR 0046 §6). */
export interface UpdaterStatus {
  phase: "idle" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  error?: string;
}

/** `window.cgsDesktop.updater`: Electron main's electron-updater wrapper (desktop/updater.mjs). */
export interface Updater {
  check(): Promise<{ version: string; available?: string }>;
  getAutoCheck(): Promise<boolean>;
  setAutoCheck(enabled: boolean): Promise<void>;
  status(): Promise<UpdaterStatus>;
  download(): Promise<void>;
  install(): Promise<void>;
  onStatus(callback: (status: UpdaterStatus) => void): () => void;
}

/** `settings.device.read` / `setRemote` on the sidecar (local-channel.md §6.2). */
interface DevicePayload {
  version: string;
  remote: boolean;
  hasPassword: boolean;
}

interface SettingsShell {
  host?: Pick<DesktopHost, "call">;
  updater?: Updater;
}

/** Just enough of `window` to reach the preload bridge; the page's global type has no updater entry yet. */
interface ShellWindow {
  cgsDesktop?: { host?: Pick<DesktopHost, "call">; updater?: Updater };
}

function shellWindow(): SettingsShell {
  if (typeof window === "undefined") return {};
  return (window as unknown as ShellWindow).cgsDesktop ?? {};
}

/**
 * The real `SettingsApi`, or undefined when the shell exposes no host link (a plain browser never asks for it). `host`
 * defaults to the preload's `window.cgsDesktop.host`; the updater is read from the same bridge, and its absence (the dev
 * shell) leaves update checks at the sidecar's version.
 */
export function createSettingsApi(host: SettingsShell["host"] = shellWindow().host, updater: Updater | undefined = shellWindow().updater): SettingsApi | undefined {
  if (!host) return undefined;

  const device = async (): Promise<DeviceSettings> => {
    const [payload, autoUpdate] = await Promise.all([
      host.call<DevicePayload>("settings.device.read"),
      // A broken updater must not hide the device state: auto-check off is the honest fallback.
      updater ? updater.getAutoCheck().catch(() => false) : Promise.resolve(false),
    ]);
    return { version: payload.version, remote: payload.remote, autoUpdate };
  };

  return {
    usage: () => host.call<UsageReport>("settings.usage"),
    agents: {
      read: () =>
        host.call<{ models: ModelOption[]; layout: Orchestration; defaults: Orchestration }>("settings.agents.read"),
      save: (layout) => host.call<Orchestration>("settings.agents.save", { layout }),
    },
    device: {
      read: device,
      async setRemote(enabled) {
        const payload = await host.call<DevicePayload>("settings.device.setRemote", { enabled });
        const autoUpdate = updater ? await updater.getAutoCheck().catch(() => false) : false;
        return { version: payload.version, remote: payload.remote, autoUpdate };
      },
      async setAutoUpdate(enabled) {
        if (!updater) return device(); // nothing can store the switch; report what the device says
        await updater.setAutoCheck(enabled);
        return { ...(await device()), autoUpdate: enabled };
      },
      async checkUpdate() {
        if (updater) return updater.check();
        const payload = await host.call<DevicePayload>("settings.device.read");
        return { version: payload.version };
      },
      signOut: async () => {
        await host.call("logout");
      },
    },
  };
}
