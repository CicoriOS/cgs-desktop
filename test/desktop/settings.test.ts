// src/desktop/settings.ts over a fake host link and a fake updater: which sidecar call each SettingsApi method makes,
// the shapes it returns, and the dev fallback when the shell has no updater.
import { expect, test, vi } from "vitest";
import type { ModelOption, Orchestration, UsageReport } from "../../src/core/settings";
import { createSettingsApi, type Updater, type UpdaterStatus } from "../../src/desktop/settings";

interface Call {
  method: string;
  params?: unknown;
}

function fakeHost(replies: Record<string, unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    host: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (!(method in replies)) throw new Error(`unexpected ${method}`);
        return replies[method] as T;
      },
    },
  };
}

function fakeUpdater(overrides: Partial<Updater> = {}) {
  const autoCheck = { value: true };
  const updater: Updater = {
    check: vi.fn(async () => ({ version: "0.3.0-next", available: "0.4.0" })),
    getAutoCheck: vi.fn(async () => autoCheck.value),
    setAutoCheck: vi.fn(async (enabled: boolean) => {
      autoCheck.value = enabled;
    }),
    status: vi.fn(async (): Promise<UpdaterStatus> => ({ phase: "idle" })),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    onStatus: () => () => {},
    ...overrides,
  };
  return updater;
}

const DEVICE = { version: "19.2.1-cgs.5", remote: false, hasPassword: false };

test("usage, agents and save go to the matching sidecar calls", async () => {
  const report: UsageReport = { currency: "CNY", entries: [] };
  const models: ModelOption[] = [{ id: "cgs-claude/claude-opus-4.5", label: "Opus 4.5", thinking: ["high"] }];
  const layout: Orchestration = { main: { model: "cgs-claude/claude-opus-4.5", thinking: "high" }, agents: [], web: "" };
  const { host, calls } = fakeHost({
    "settings.usage": report,
    "settings.agents.read": { models, layout, defaults: layout },
    "settings.agents.save": layout,
  });
  const api = createSettingsApi(host, fakeUpdater());
  expect(api).toBeDefined();

  await expect(api!.usage()).resolves.toEqual(report);
  await expect(api!.agents.read()).resolves.toEqual({ models, layout, defaults: layout });
  await expect(api!.agents.save(layout)).resolves.toEqual(layout);
  expect(calls).toEqual([
    { method: "settings.usage" },
    { method: "settings.agents.read" },
    { method: "settings.agents.save", params: { layout } },
  ]);
});

test("device.read combines the sidecar's device state with the shell's auto-check switch", async () => {
  const { host } = fakeHost({ "settings.device.read": DEVICE });
  const updater = fakeUpdater();
  const api = createSettingsApi(host, updater)!;
  await expect(api.device.read()).resolves.toEqual({ version: DEVICE.version, remote: false, autoUpdate: true });
  expect(updater.getAutoCheck).toHaveBeenCalled();
});

test("setRemote sends enabled and keeps the updater's auto-check value", async () => {
  const { host, calls } = fakeHost({ "settings.device.setRemote": { ...DEVICE, remote: true } });
  const api = createSettingsApi(host, fakeUpdater())!;
  await expect(api.device.setRemote(true)).resolves.toEqual({ version: DEVICE.version, remote: true, autoUpdate: true });
  expect(calls).toEqual([{ method: "settings.device.setRemote", params: { enabled: true } }]);
});

test("without an updater the device is still readable and update checks fall back to the CLI version", async () => {
  const { host, calls } = fakeHost({ "settings.device.read": DEVICE });
  const api = createSettingsApi(host, undefined)!;
  await expect(api.device.read()).resolves.toEqual({ version: DEVICE.version, remote: false, autoUpdate: false });
  await expect(api.device.checkUpdate()).resolves.toEqual({ version: DEVICE.version });
  await expect(api.device.setAutoUpdate(true)).resolves.toMatchObject({ autoUpdate: false });
  expect(calls.filter((call) => call.method === "settings.device.read")).toHaveLength(3);
});

test("setAutoUpdate writes the shell's auto-check switch and returns the new state", async () => {
  const { host } = fakeHost({ "settings.device.read": DEVICE });
  const updater = fakeUpdater();
  const api = createSettingsApi(host, updater)!;
  await expect(api.device.setAutoUpdate(false)).resolves.toEqual({ version: DEVICE.version, remote: false, autoUpdate: false });
  expect(updater.setAutoCheck).toHaveBeenCalledWith(false);
  await expect(api.device.checkUpdate()).resolves.toEqual({ version: "0.3.0-next", available: "0.4.0" });
});

test("signOut asks the sidecar for logout", async () => {
  const { host, calls } = fakeHost({ logout: null });
  const api = createSettingsApi(host, fakeUpdater())!;
  await api.device.signOut();
  expect(calls).toEqual([{ method: "logout" }]);
});

test("no host link means no settings API", () => {
  expect(createSettingsApi(undefined, fakeUpdater())).toBeUndefined();
});
