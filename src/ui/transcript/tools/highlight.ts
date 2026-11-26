// Syntax highlighting for tool cards (highlight.js core + a fixed set of languages). Output is HTML built by highlight.js from
// escaped input, so it is safe to inject; nothing here ever passes tool text through unescaped.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { DiffLine } from "./diff";

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua, makefile, markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

/** File extension (or whole file name) to a registered language. */
const BY_EXT: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp", css: "css", scss: "css",
  diff: "diff", patch: "diff", dockerfile: "dockerfile", go: "go", ini: "ini", toml: "ini", conf: "ini", java: "java",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", json: "json", jsonc: "json", kt: "kotlin", lua: "lua",
  makefile: "makefile", mk: "makefile", md: "markdown", markdown: "markdown", php: "php", py: "python", rb: "ruby", rs: "rust",
  sql: "sql", swift: "swift", ts: "typescript", tsx: "typescript", mts: "typescript", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  vue: "xml", yml: "yaml", yaml: "yaml",
};

/** Beyond this many characters a file is shown plain: highlighting it would stall the page. */
const MAX_CHARS = 150_000;

/** Language for a path; a `:50-80` read selector is ignored. Undefined when unknown. */
export function langOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const file = (path.replace(/:[\d,\-+raw]*$/, "").split(/[\\/]/).pop() ?? "").toLowerCase();
  return BY_EXT[file] ?? BY_EXT[file.slice(file.lastIndexOf(".") + 1)];
}

const TOKEN = /(<span[^>]*>|<\/span>|\n)/;

/** Splits highlight.js output into one self-contained HTML string per line, closing and reopening spans that cross a newline. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const part of html.split(TOKEN)) {
    if (part === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (part.startsWith("<span")) {
      open.push(part);
      cur += part;
    } else if (part === "</span>") {
      open.pop();
      cur += part;
    } else cur += part;
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

/** Highlighted HTML for the whole text (one string, newlines kept), or undefined when it cannot or should not be highlighted. */
export function highlightHtml(text: string, lang: string | undefined): string | undefined {
  if (!lang || !hljs.getLanguage(lang) || text.length > MAX_CHARS) return undefined;
  return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
}

/** Highlighted HTML per line of `text`, or undefined. */
export function highlightLines(text: string, lang: string | undefined): string[] | undefined {
  const html = highlightHtml(text, lang);
  return html === undefined ? undefined : splitHighlighted(html);
}

/**
 * Highlighted HTML per diff line (same indexes). A diff mixes two versions of the file, so each hunk is highlighted twice, as the
 * old side (context + removed) and the new side (context + added); a line takes the HTML of the side it belongs to. Undefined
 * entries (gaps, or everything when the language is unknown or the diff is too large) render as plain text.
 */
export function highlightDiff(lines: DiffLine[], lang: string | undefined): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(lines.length).fill(undefined);
  if (!lang || !hljs.getLanguage(lang) || lines.reduce((n, l) => n + l.text.length + 1, 0) > MAX_CHARS) return out;
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && lines[i]!.kind !== "gap") continue;
    const hunk = lines.slice(start, i);
    for (const side of ["del", "add"] as const) {
      const idx = hunk.map((_, k) => k).filter((k) => hunk[k]!.kind === "ctx" || hunk[k]!.kind === side);
      if (!idx.length) continue;
      const html = highlightLines(idx.map((k) => hunk[k]!.text).join("\n"), lang);
      if (!html) continue;
      for (const [n, k] of idx.entries()) if (hunk[k]!.kind === side || out[start + k] === undefined) out[start + k] = html[n];
    }
    start = i + 1;
  }
  return out;
}
