import { version } from "../../package.json";
import type { DeviceSettings, ModelOption, Orchestration, SettingsApi, UsageEntry } from "../core/settings";

const MODELS: ModelOption[] = [
  { id: "cgs/claude-opus-4.5", label: "Claude Opus 4.5", thinking: ["low", "medium", "high", "max"] },
  { id: "cgs/claude-sonnet-4.5", label: "Claude Sonnet 4.5", thinking: ["low", "medium", "high"] },
  { id: "cgs/gpt-5", label: "GPT-5", thinking: ["minimal", "low", "medium", "high"] },
  { id: "cgs/gemini-3-pro", label: "Gemini 3 Pro", thinking: ["low", "high"] },
];

const DEFAULTS: Orchestration = {
  main: { model: "cgs/claude-opus-4.5", thinking: "auto" },
  agents: [
    { name: "explore", builtIn: true, model: "cgs/claude-sonnet-4.5", thinking: "low" },
    { name: "plan", builtIn: true, model: "", thinking: "" },
    { name: "task", builtIn: true, model: "", thinking: "" },
    { name: "reviewer", builtIn: true, model: "cgs/gpt-5", thinking: "high" },
  ],
  web: "",
};

export function demoSettings(signOut: () => void): SettingsApi {
  const now = Date.now();
  const entries: UsageEntry[] = [];
  for (let day = 0; day < 90; day++) {
    if (day % 5 === 3) continue;
    for (const [i, model] of MODELS.entries()) {
      if ((day + i) % 3 === 0) continue;
      const n = (day * 7 + i * 13) % 28 + 3;
      entries.push({
        at: now - day * 86_400_000,
        model: model.label,
        project: ["cgs-web", "payments-api", "notes"][(day + i) % 3]!,
        input: n * 1870,
        cacheRead: n * 8192,
        output: n * 412,
        cost: n * [0.22, 0.078, 0.05, 0.039][i]!,
        cacheSavings: n * [0.113, 0.04, 0.027, 0.019][i]!,
      });
    }
  }
  let layout = structuredClone(DEFAULTS);
  let device: DeviceSettings = { version, remote: false, autoUpdate: true };
  return {
    preview: true,
    usage: async () => ({ currency: "CNY", entries }),
    agents: {
      read: async () => ({ models: MODELS, layout, defaults: DEFAULTS }),
      save: async (next) => (layout = structuredClone(next)),
    },
    device: {
      read: async () => device,
      setRemote: async (remote) => (device = { ...device, remote }),
      setAutoUpdate: async (autoUpdate) => (device = { ...device, autoUpdate }),
      checkUpdate: async () => ({ version: device.version }),
      signOut: async () => signOut(),
    },
  };
}
