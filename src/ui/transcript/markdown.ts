// Safe markdown for model output: no raw HTML ever reaches the page (everything is escaped first).
// Supports headings, paragraphs, emphasis, links, nested and task lists, tables, quotes, rules, code, and ```svg / ```mermaid fences.

export type MdBlock = { kind: "html"; html: string } | { kind: "mermaid"; src: string };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]!);

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function inline(src: string): string {
  const codes: string[] = [];
  const t = escapeHtml(src)
    .replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

function blockStart(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return /^(```|#{1,6}\s|>)/.test(l) || LIST.test(l) || RULE.test(l) || (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!));
}

function list(lines: string[], start: number): [string, number] {
  const first = LIST.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]!);
    if (!m || m[1]!.length < base) break;
    if (m[1]!.length > base) {
      const [html, next] = list(lines, i);
      items[items.length - 1] += html;
      i = next;
      continue;
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!);
    items.push(task ? `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2]!)}` : inline(m[3]!));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}>${items.map((x) => `<li${x.startsWith("<input") ? ' class="task"' : ""}>${x}</li>`).join("")}</${tag}>`, i];
}

function table(lines: string[], start: number): [string, number] {
  const align = cells(lines[start + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
  const cell = (tag: string, c: string, k: number) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
  const head = cells(lines[start]!).map((c, k) => cell("th", c, k)).join("");
  const rows: string[] = [];
  let i = start + 2;
  for (; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) rows.push(`<tr>${cells(lines[i]!).map((c, k) => cell("td", c, k)).join("")}</tr>`);
  return [`<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`, i];
}

/** Converts markdown to blocks; consecutive HTML is merged so the page renders one chunk per run of ordinary text. */
export function markdownBlocks(src: string, allowDiagrams = true): MdBlock[] {
  const out: MdBlock[] = [];
  const html = (h: string) => {
    const last = out.at(-1);
    if (last?.kind === "html") last.html += h;
    else out.push({ kind: "html", html: h });
  };
  const lines = src.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const fence = /^```(\S*)/.exec(line);
    const head = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      const closed = i < lines.length; // a fence still streaming stays plain code
      i++;
      const body = code.join("\n");
      const lang = fence[1]!.toLowerCase();
      if (closed && allowDiagrams && lang === "mermaid") out.push({ kind: "mermaid", src: body });
      else if (closed && lang === "svg") html(`<div class="svg-box"><img alt="svg" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}"></div>`);
      else html(`<pre><code>${escapeHtml(body)}</code></pre>`);
    } else if (head) {
      html(`<h${head[1]!.length}>${inline(head[2]!)}</h${head[1]!.length}>`);
      i++;
    } else if (RULE.test(line)) {
      html("<hr>");
      i++;
    } else if (line.startsWith(">")) {
      const q: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) q.push(lines[i]!.replace(/^>\s?/, ""));
      html(`<blockquote>${markdownBlocks(q.join("\n"), false).map((b) => (b.kind === "html" ? b.html : "")).join("")}</blockquote>`);
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const [h, next] = table(lines, i);
      html(h);
      i = next;
    } else if (LIST.test(line)) {
      const [h, next] = list(lines, i);
      html(h);
      i = next;
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && (!para.length || !blockStart(lines, i)); i++) para.push(inline(lines[i]!));
      html(`<p>${para.join("<br>")}</p>`);
    }
  }
  return out;
}
