export const NATIVE_PROVIDERS = [
  { id: "codex", name: "ChatGPT Codex", logo: "codex-mark.png", plan: "ChatGPT Plus", usage: [32, 62] },
  { id: "claude", name: "Claude Code", logo: "claude-mark.svg", plan: "Claude Max", usage: [86, 41] },
] as const;

export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];
export type PreviewSignIns = Partial<Record<NativeProvider["id"], number>>;
