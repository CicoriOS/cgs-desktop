import { Bell, Bot, Cable, Cpu, Gauge, Network, RefreshCw, Settings, ShieldCheck, Sparkles, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MessageKey, t as translate } from "../../i18n";
import { settingsZh } from "../../i18n/settings.zh";

type Key = keyof typeof settingsZh;
/** A setting: `set.row.<id>` is its name and `set.row.<id>.d` its help, both required by the type of the strings. */
export type RowId = Exclude<Extract<Key, `set.row.${string}`>, `${string}.d`>;
export type OptId = Extract<Key, `set.opt.${string}`>;
type SectionId = Extract<Key, `set.sec.${string}`>;
export type GroupId = "app" | "agent" | "system";
export type PageId = "usage" | "general" | "appearance" | "notifications" | "models" | "safety" | "intelligence" | "agents" | "extensions" | "hosts" | "system";

export type Value = boolean | number | string;
/** A choice is a translated `set.opt.*` key, or text shown as it is (model names, "100%"). */
export const isOpt = (choice: string): choice is OptId => choice in settingsZh;

/** What sits at the right of a row. Everything but `locale` is a placeholder: the value lives in the page and goes nowhere. */
export type Control =
  | { kind: "toggle"; value: boolean }
  | { kind: "select"; value: string; options: string[] }
  | { kind: "segmented"; value: OptId; options: OptId[] }
  | { kind: "number"; value: number; min: number; max: number; unit?: string }
  | { kind: "area"; value: string; rows: number }
  | { kind: "button"; label: OptId }
  | { kind: "locale" };

export interface Row {
  id: RowId;
  control: Control;
}
export interface Section {
  title?: SectionId;
  rows: Row[];
}
export interface Page {
  id: PageId;
  group: GroupId;
  icon: LucideIcon;
  sections: Section[];
  keywords?: MessageKey[];
}

const toggle = (id: RowId, value: boolean): Row => ({ id, control: { kind: "toggle", value } });
const select = (id: RowId, value: string, options: string[]): Row => ({ id, control: { kind: "select", value, options } });
const segmented = (id: RowId, value: OptId, options: OptId[]): Row => ({ id, control: { kind: "segmented", value, options } });
const number = (id: RowId, value: number, min: number, max: number, unit?: string): Row => ({ id, control: { kind: "number", value, min, max, unit } });
const button = (id: RowId, label: OptId): Row => ({ id, control: { kind: "button", label } });

const OPUS = "claude-opus-4.5";
const SONNET = "claude-sonnet-4.5";
const MODELS = [OPUS, SONNET, "gpt-5", "gemini-3-pro"];
const LEVELS: OptId[] = ["set.opt.low", "set.opt.medium", "set.opt.high"];
const ASK: string[] = ["set.opt.deny", "set.opt.ask", "set.opt.allow"];

/** The pages, in the order the list shows them: what omp offers, laid out the way ChatGPT lays out its settings. */
export const PAGES: Page[] = [
  {
    id: "general",
    group: "app",
    icon: Settings,
    sections: [
      {
        title: "set.sec.interface",
        rows: [
          { id: "set.row.language", control: { kind: "locale" } },
          toggle("set.row.openUrl", false),
          select("set.row.activeRun", "set.opt.queue", ["set.opt.queue", "set.opt.steer", "set.opt.ask"]),
          toggle("set.row.wordCompletion", true),
        ],
      },
      { title: "set.sec.toolCalls", rows: [toggle("set.row.keepCollapsed", true), toggle("set.row.expandThinking", false), toggle("set.row.hideActivity", false)] },
    ],
  },
  {
    id: "appearance",
    group: "app",
    icon: Sun,
    sections: [
      { title: "set.sec.theme", rows: [segmented("set.row.theme", "set.opt.system", ["set.opt.system", "set.opt.light", "set.opt.dark"]), toggle("set.row.glass", true)] },
      {
        title: "set.sec.layout",
        rows: [
          number("set.row.fontSize", 15, 12, 22, "px"),
          select("set.row.scale", "100%", ["90%", "100%", "110%", "125%"]),
          segmented("set.row.density", "set.opt.comfortable", ["set.opt.compact", "set.opt.comfortable", "set.opt.spacious"]),
          toggle("set.row.rightPanel", false),
        ],
      },
    ],
  },
  {
    id: "notifications",
    group: "app",
    icon: Bell,
    sections: [
      { rows: [toggle("set.row.notify", true)] },
      { title: "set.sec.types", rows: [toggle("set.row.notifyDone", true), toggle("set.row.notifyInput", true), toggle("set.row.notifyError", true), toggle("set.row.notifySwitch", false)] },
      { rows: [select("set.row.whenActive", "set.opt.toast", ["set.opt.toast", "set.opt.notice", "set.opt.never"]), button("set.row.notifyTest", "set.opt.sendTest")] },
    ],
  },
  {
    id: "usage",
    group: "app",
    icon: Gauge,
    keywords: ["set.ui.range", "set.ui.tokens", "set.ui.cost", "set.ui.planUsage"],
    sections: [],
  },
  {
    id: "models",
    group: "agent",
    icon: Cpu,
    sections: [
      { title: "set.sec.defaults", rows: [select("set.row.defaultModel", OPUS, MODELS), select("set.row.fastModel", SONNET, MODELS)] },
      {
        title: "set.sec.reasoning",
        rows: [
          select("set.row.reasoning", "set.opt.auto", ["set.opt.off", "set.opt.auto", ...LEVELS]),
          select("set.row.autoSource", "set.opt.currentModel", ["set.opt.currentModel", "set.opt.fastModel"]),
          segmented("set.row.verbosity", "set.opt.medium", LEVELS),
          select("set.row.personality", "set.opt.default", ["set.opt.default", "set.opt.concise", "set.opt.friendly", "set.opt.rigorous"]),
        ],
      },
      { title: "set.sec.thinking", rows: [toggle("set.row.thinkingBlocks", true), toggle("set.row.externalThinking", false)] },
    ],
  },
  {
    id: "safety",
    group: "agent",
    icon: ShieldCheck,
    sections: [
      {
        title: "set.sec.approvals",
        rows: [
          select("set.row.approval", "set.opt.ask", ["set.opt.ask", "set.opt.autoEdits", "set.opt.yolo"]),
          toggle("set.row.bashOverride", true),
          select("set.row.extTools", "set.opt.ask", ASK),
          { id: "set.row.protectedPaths", control: { kind: "area", value: ".env\n~/.ssh\n~/.cgs", rows: 3 } },
        ],
      },
    ],
  },
  {
    id: "intelligence",
    group: "agent",
    icon: Sparkles,
    sections: [
      {
        title: "set.sec.compaction",
        rows: [toggle("set.row.autoCompact", true), toggle("set.row.continueAfter", true), toggle("set.row.compactMid", false), select("set.row.compactMethod", "set.opt.handoff", ["set.opt.handoff", "set.opt.summary", "set.opt.prune"])],
      },
      {
        title: "set.sec.memory",
        rows: [
          select("set.row.memoryBackend", "set.opt.local", ["set.opt.off", "set.opt.local"]),
          toggle("set.row.autoLearn", false),
          select("set.row.memoryScope", "set.opt.project", ["set.opt.project", "set.opt.global"]),
          toggle("set.row.recallStart", true),
          number("set.row.retainTurns", 5, 0, 50),
        ],
      },
      { title: "set.sec.retry", rows: [toggle("set.row.autoRetry", true), number("set.row.maxAttempts", 3, 1, 10), toggle("set.row.modelFallback", true)] },
    ],
  },
  {
    id: "agents",
    group: "agent",
    icon: Bot,
    keywords: ["set.ui.orchestration", "set.ui.mainModel", "set.ui.webSearch"],
    sections: [
      {
        title: "set.sec.policy",
        rows: [number("set.row.maxParallel", 4, 1, 16), select("set.row.agentToolPolicy", "set.opt.inherit", ["set.opt.inherit", "set.opt.readOnly", "set.opt.full"]), toggle("set.row.subagentAsk", true)],
      },
    ],
  },
  {
    id: "extensions",
    group: "agent",
    icon: Cable,
    sections: [
      { title: "set.sec.mcp", rows: [toggle("set.row.loadProjectMcp", true), toggle("set.row.renderMcpMd", true), toggle("set.row.mcpUpdates", true)] },
      { title: "set.sec.servers", rows: [toggle("set.row.mcpFs", true), toggle("set.row.mcpGithub", true), toggle("set.row.mcpBrowser", false), button("set.row.mcpAdd", "set.opt.add")] },
      { title: "set.sec.skills", rows: [toggle("set.row.skillsAuto", true), button("set.row.skillsManage", "set.opt.manage")] },
      { title: "set.sec.plugins", rows: [toggle("set.row.pluginsEnable", true), button("set.row.pluginsBrowse", "set.opt.browse")] },
    ],
  },
  {
    id: "hosts",
    group: "system",
    icon: Network,
    keywords: ["set.ui.remote", "set.ui.update", "set.row.autoUpdate", "set.row.checkUpdate", "set.row.logout"],
    sections: [],
  },
  {
    id: "system",
    group: "system",
    icon: RefreshCw,
    sections: [
      { title: "set.sec.session", rows: [toggle("set.row.autoResume", true), toggle("set.row.crossSession", false)] },
      {
        title: "set.sec.github",
        rows: [toggle("set.row.ghWrites", false), select("set.row.ghDispatch", "set.opt.ask", ASK), select("set.row.ghCancel", "set.opt.ask", ASK), select("set.row.ghRerun", "set.opt.ask", ASK)],
      },
      { title: "set.sec.storage", rows: [select("set.row.uploadRetention", "set.opt.d30", ["set.opt.d7", "set.opt.d30", "set.opt.d90", "set.opt.forever"])] },
      { title: "set.sec.env", rows: [{ id: "set.row.agentEnv", control: { kind: "area", value: "HTTP_PROXY=http://127.0.0.1:7890", rows: 3 } }] },
      { title: "set.sec.connection", rows: [select("set.row.transport", "set.opt.auto", ["set.opt.auto", "WebSocket", "SSE"]), button("set.row.diagnostics", "set.opt.run")] },
    ],
  },
];

export const GROUPS: GroupId[] = ["app", "agent", "system"];

/** What a placeholder setting starts at: the first value of every control that holds one. */
export function defaultValues(): Record<string, Value> {
  const values: Record<string, Value> = {};
  for (const page of PAGES) for (const section of page.sections) for (const { id, control } of section.rows) if ("value" in control) values[id] = control.value;
  return values;
}

export interface Hit {
  page: Page;
  row?: Row;
}

/** The settings whose name, help, section or page contain every word of `query` (case-insensitive), in list order. */
export function searchSettings(query: string, tr: typeof translate): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const page of PAGES) {
    const pageName = tr(`set.page.${page.id}`);
    if (page.keywords) {
      const keywords = `${pageName} ${page.keywords.map((key) => tr(key)).join(" ")}`.toLowerCase();
      if (words.every((w) => keywords.includes(w))) hits.push({ page });
    }
    for (const section of page.sections) {
      for (const row of section.rows) {
        const text: MessageKey[] = [row.id, `${row.id}.d`];
        const haystack = `${text.map((k) => tr(k)).join(" ")} ${section.title ? tr(section.title) : ""} ${pageName}`.toLowerCase();
        if (words.every((w) => haystack.includes(w))) hits.push({ page, row });
      }
    }
  }
  return hits;
}
