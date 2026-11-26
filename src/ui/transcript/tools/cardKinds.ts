export type CardKind = "bash" | "read" | "edit" | "write" | "text" | "eval" | "task" | "todo" | "web" | "ast" | "ask" | "jobs" | "operation" | "media" | "mcp" | "generic";

/** Canonical names from omp's BUILTIN_TOOLS/HIDDEN_TOOLS, plus wire names and older transcripts. */
export const TOOL_CARD_KINDS: Readonly<Record<string, CardKind>> = {
  read: "read", bash: "bash", edit: "edit", apply_patch: "edit", write: "write",
  grep: "text", search: "text", glob: "text", find: "text",
  ast_grep: "ast", ast_edit: "ast", eval: "eval", ask: "ask", todo: "todo",
  task: "task", subagent: "task", wait: "jobs", cancel: "jobs", cancel_subagent: "jobs", send: "jobs",
  vibe_spawn: "operation", vibe_send: "operation", vibe_wait: "jobs", vibe_list: "jobs", vibe_kill: "jobs",
  web_search: "web", fetch: "web", browser: "operation", computer: "operation", github: "operation",
  lsp: "operation", debug: "operation", security_scan: "operation",
  checkpoint: "operation", rewind: "operation", context_notes: "operation", new_context: "operation",
  memory_edit: "operation", retain: "operation", recall: "operation", reflect: "operation", learn: "operation",
  manage_skill: "operation", skill: "operation", read_skill: "operation", notebook: "operation",
  notebook_read: "read", notebook_edit: "edit", plan: "operation", exit_plan: "operation", exit_plan_mode: "operation",
  propose: "operation", resolve: "operation", reject: "operation", goal: "operation", yield: "operation",
  inspect_image: "media", image_gen: "media", generate_image: "media", calc: "operation", tts: "media",
  // The thought tool is intentionally a free-form prompt and response.
  think: "generic",
};

export function toolCardKind(name: string): CardKind {
  if (Object.hasOwn(TOOL_CARD_KINDS, name)) return TOOL_CARD_KINDS[name]!;
  if (name.startsWith("mcp__")) return "mcp";
  if (name.startsWith("gh_")) return "operation";
  return "generic";
}
