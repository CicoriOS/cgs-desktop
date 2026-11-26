// Port of omp's agent-form model (packages/coding-agent/src/tools/html-form/parse.ts) onto the browser DOM, so the client reads the HTML
// form of an `ask` request exactly as omp validates it. Keep the semantics in step with omp: grouping by name, the "Other" answer,
// defaults. DOM access goes through nodeType checks, not instanceof, so any DOM implementation (a test one) works.

/** Inline emphasis a span keeps from `<code>`, `<strong>`/`<b>` and `<em>`/`<i>`. */
export type FormSpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break (`<br>`). */
export interface FormSpan {
  text: string;
  style?: FormSpanStyle;
}

export interface ChoiceOption {
  value: string;
  label: FormSpan[];
  checked: boolean;
  disabled: boolean;
}

/** A radio group (`multi: false`), checkbox group (`multi: true`) or `<select>` (`select: true`). */
export interface ChoiceField {
  kind: "choice";
  name: string;
  multi: boolean;
  select: boolean;
  /** The UI adds a free-text "Other" answer: radio and checkbox groups of two or more options that don't offer one themselves. */
  other: boolean;
  label: FormSpan[];
  options: ChoiceOption[];
  required: boolean;
}

/** A single-line `<input>` or a `<textarea>`. */
export interface TextField {
  kind: "text";
  name: string;
  type: string;
  multiline: boolean;
  label: FormSpan[];
  value: string;
  placeholder: string;
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  rows: number;
}

export type FormField = ChoiceField | TextField;

export type FormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: FormSpan[][][]; headerRows: number }
  | { kind: "image"; src: string; alt: string }
  | { kind: "svg"; markup: string; alt: string }
  | { kind: "field"; field: FormField };

/** A `<fieldset>` (titled by its `<legend>`) or loose content between fieldsets (untitled). */
export interface FormSection {
  title: FormSpan[];
  blocks: FormBlock[];
  fieldset: boolean;
}

export interface HtmlForm {
  sections: FormSection[];
  fields: FormField[];
  /** `<input type="hidden">` pairs. */
  hidden: [name: string, value: string][];
}

export type ParseDocument = (html: string) => Document;
const browserParse: ParseDocument = (html) => new DOMParser().parseFromString(html, "text/html");

const set = (...names: string[]): Record<string, true> => Object.fromEntries(names.map((n) => [n, true]));
const SKIPPED = set("button", "head", "iframe", "link", "meta", "noscript", "script", "style", "template", "title");
const BLOCK = set("address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figure", "figcaption", "footer", "header", "li", "main", "nav", "p", "section");
const HEADING = set("h1", "h2", "h3", "h4", "h5", "h6", "summary");
const STYLE_OF: Record<string, FormSpanStyle> = { b: "strong", code: "code", em: "em", i: "em", kbd: "code", samp: "code", strong: "strong", tt: "code" };
const IGNORED_INPUTS = set("button", "file", "image", "reset", "submit");
const CONTROL_SELECTOR = "input, select, textarea";

const ELEMENT = 1;
const TEXT = 3;
const isElement = (n: Node): n is Element => n.nodeType === ELEMENT;
const kids = (e: Element): Element[] => Array.from(e.children);
const all = (e: ParentNode, selector: string): Element[] => Array.from(e.querySelectorAll(selector));

/** Parses agent-written form HTML; content outside the first `<form>` is ignored when one exists. */
export function parseHtmlForm(html: string, parse: ParseDocument = browserParse): HtmlForm {
  const doc = parse(html);
  return new FormBuilder((doc.querySelector("form") ?? doc.body ?? doc) as ParentNode & Node).build();
}

function appendSpan(spans: FormSpan[], text: string, style: FormSpanStyle | undefined): void {
  if (!text) return;
  const last = spans.at(-1);
  if (last && last.style === style) last.text += text;
  else spans.push(style ? { text, style } : { text });
}

/** Collapses whitespace like HTML layout: runs become one space, spaces next to a hard break vanish, the ends are trimmed. */
function normalizeSpans(spans: FormSpan[]): FormSpan[] {
  const out: FormSpan[] = [];
  for (const span of spans) appendSpan(out, span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"), span.style);
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out.at(-1);
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((s) => s.text !== "");
}

export const spansText = (spans: readonly FormSpan[]): string => spans.map((s) => s.text).join("");

function svgTitle(svg: Element): string {
  const label = svg.getAttribute("aria-label");
  if (label) return label.trim();
  const title = kids(svg).find((c) => c.localName === "title");
  return (title?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function numberAttr(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

class FormBuilder {
  readonly #root: ParentNode & Node;
  readonly #sections: FormSection[] = [];
  readonly #fields: FormField[] = [];
  readonly #hidden: [string, string][] = [];
  readonly #groups = new Map<string, ChoiceField>();
  readonly #labelFor = new Map<string, Element>();
  #section: FormSection = { title: [], blocks: [], fieldset: false };
  #inline: FormSpan[] = [];
  #fieldsetDepth = 0;

  constructor(root: ParentNode & Node) {
    this.#root = root;
    this.#sections.push(this.#section);
  }

  build(): HtmlForm {
    const ids = new Set<string>();
    for (const control of all(this.#root, CONTROL_SELECTOR)) if (control.id) ids.add(control.id);
    for (const label of all(this.#root, "label")) {
      const target = label.getAttribute("for");
      if (target && ids.has(target) && !this.#labelFor.has(target)) this.#labelFor.set(target, label);
    }
    this.#children(this.#root, undefined);
    this.#flush(false);
    for (const field of this.#fields) {
      if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
      field.other = !field.options.some((o) => /^\s*other\b/i.test(spansText(o.label)));
    }
    return { sections: this.#sections.filter((s) => s.blocks.length > 0 || s.title.length > 0), fields: this.#fields, hidden: this.#hidden };
  }

  #children(node: Node, style: FormSpanStyle | undefined): void {
    for (const child of Array.from(node.childNodes)) this.#walk(child, style);
  }

  #walk(node: Node, style: FormSpanStyle | undefined): void {
    if (node.nodeType === TEXT) {
      appendSpan(this.#inline, (node as Text).data, style);
      return;
    }
    if (!isElement(node)) return; // comments and the rest
    const tag = node.localName;
    if (SKIPPED[tag]) return;
    switch (tag) {
      case "br":
        appendSpan(this.#inline, "\n", undefined);
        return;
      case "hr":
        this.#flush(false);
        return;
      case "input":
      case "select":
      case "textarea":
        this.#control(node, undefined);
        return;
      case "label":
        this.#label(node, style);
        return;
      case "fieldset":
        this.#fieldset(node);
        return;
      case "legend":
        this.#flush(false);
        this.#children(node, style);
        this.#flush(true);
        return;
      case "ul":
      case "ol":
        this.#list(node, tag === "ol");
        return;
      case "pre":
        this.#flush(false);
        this.#section.blocks.push({ kind: "pre", text: (node.textContent ?? "").replace(/^\n/, "").trimEnd() });
        return;
      case "table":
        this.#table(node);
        return;
      case "img": {
        const src = node.getAttribute("src")?.trim();
        if (!src) return;
        this.#flush(false);
        this.#section.blocks.push({ kind: "image", src, alt: (node.getAttribute("alt") ?? "").trim() });
        return;
      }
      case "svg":
        this.#flush(false);
        this.#section.blocks.push({ kind: "svg", markup: node.outerHTML, alt: svgTitle(node) });
        return;
    }
    if (HEADING[tag]) {
      this.#flush(false);
      this.#children(node, style);
      this.#flush(true);
      return;
    }
    if (BLOCK[tag]) {
      this.#flush(false);
      this.#children(node, style);
      this.#flush(false);
      return;
    }
    this.#children(node, STYLE_OF[tag] ?? style);
  }

  #flush(heading: boolean): void {
    const spans = normalizeSpans(this.#inline);
    this.#inline = [];
    if (spans.length > 0) this.#section.blocks.push({ kind: "text", spans, heading });
  }

  /** Inline spans of `element`, skipping controls (their label is the text around them). */
  #spansOf(element: Element): FormSpan[] {
    const spans: FormSpan[] = [];
    const visit = (node: Node, style: FormSpanStyle | undefined): void => {
      if (node.nodeType === TEXT) {
        appendSpan(spans, (node as Text).data, style);
        return;
      }
      if (!isElement(node)) return;
      const tag = node.localName;
      if (SKIPPED[tag] || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return;
      if (tag === "br") {
        appendSpan(spans, "\n", undefined);
        return;
      }
      if (tag === "img") {
        appendSpan(spans, node.getAttribute("alt") ?? "", style); // a picture inside a label reads as its alt text
        return;
      }
      if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
      for (const child of Array.from(node.childNodes)) visit(child, STYLE_OF[tag] ?? style);
    };
    for (const child of Array.from(element.childNodes)) visit(child, undefined);
    return normalizeSpans(spans);
  }

  #label(label: Element, style: FormSpanStyle | undefined): void {
    const target = label.getAttribute("for");
    if (target && this.#labelFor.get(target) === label) return;
    const controls = all(label, CONTROL_SELECTOR);
    if (controls.length === 0) {
      this.#children(label, style);
      return;
    }
    this.#flush(false);
    const spans = this.#spansOf(label);
    for (const control of controls) this.#control(control, spans);
  }

  #fieldset(fieldset: Element): void {
    this.#flush(false);
    const legend = kids(fieldset).find((c) => c.localName === "legend");
    if (this.#fieldsetDepth > 0) {
      if (legend) this.#walk(legend, undefined); // nested fieldsets stay in the outer section; their legend becomes a heading
    } else {
      this.#startSection(legend ? this.#spansOf(legend) : [], true);
    }
    this.#fieldsetDepth++;
    for (const child of Array.from(fieldset.childNodes)) if (child !== legend) this.#walk(child, undefined);
    this.#flush(false);
    this.#fieldsetDepth--;
    if (this.#fieldsetDepth === 0) this.#startSection([], false);
  }

  #startSection(title: FormSpan[], fieldset: boolean): void {
    if (this.#section.blocks.length === 0 && this.#section.title.length === 0) {
      this.#section.title = title;
      this.#section.fieldset = fieldset;
      return;
    }
    this.#section = { title, blocks: [], fieldset };
    this.#sections.push(this.#section);
  }

  #list(list: Element, ordered: boolean): void {
    this.#flush(false);
    if (list.querySelector(CONTROL_SELECTOR)) {
      this.#children(list, undefined); // a list of controls is layout, not content
      this.#flush(false);
      return;
    }
    const items = kids(list).filter((c) => c.localName === "li").map((li) => this.#spansOf(li)).filter((s) => s.length > 0);
    if (items.length > 0) this.#section.blocks.push({ kind: "list", items, ordered });
  }

  #table(table: Element): void {
    this.#flush(false);
    const rows = all(table, "tr").filter((r) => r.closest("table") === table);
    const cellsOf = (row: Element) => kids(row).filter((c) => c.localName === "td" || c.localName === "th");
    if (!table.querySelector(CONTROL_SELECTOR)) {
      const cells = rows.map((r) => cellsOf(r).map((c) => this.#spansOf(c)));
      let headerRows = 0;
      while (headerRows < rows.length && (rows[headerRows]!.closest("thead") !== null || cellsOf(rows[headerRows]!).every((c) => c.localName === "th"))) headerRows++;
      if (cells.some((r) => r.length > 0)) this.#section.blocks.push({ kind: "table", rows: cells, headerRows });
      return;
    }
    // A table of controls (a decision matrix): each row's text becomes a line and each unlabeled control borrows its column header.
    let header: FormSpan[][] = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (cells.every((c) => c.localName === "th") && !row.querySelector(CONTROL_SELECTOR)) {
        header = cells.map((c) => this.#spansOf(c));
        continue;
      }
      const text: FormSpan[] = [];
      for (const cell of cells) {
        if (cell.querySelector(CONTROL_SELECTOR)) continue;
        const spans = this.#spansOf(cell);
        if (spans.length === 0) continue;
        if (text.length > 0) appendSpan(text, " · ", undefined);
        for (const s of spans) appendSpan(text, s.text, s.style);
      }
      if (text.length > 0) this.#section.blocks.push({ kind: "text", spans: text, heading: false });
      cells.forEach((cell, column) => {
        for (const control of all(cell, CONTROL_SELECTOR)) {
          const own = control.closest("label");
          const spans = own && cell.contains(own) ? this.#spansOf(own) : this.#spansOf(cell);
          this.#control(control, spans.length > 0 ? spans : (header[column] ?? []));
        }
      });
    }
  }

  #detachedLabel(control: Element): FormSpan[] {
    const label = control.id ? this.#labelFor.get(control.id) : undefined;
    if (label) return this.#spansOf(label);
    const text = control.getAttribute("aria-label") ?? control.getAttribute("title");
    return text ? normalizeSpans([{ text }]) : [];
  }

  #control(control: Element, wrapping: FormSpan[] | undefined): void {
    this.#flush(false);
    const label = wrapping && wrapping.length > 0 ? wrapping : this.#detachedLabel(control);
    const name = control.getAttribute("name") ?? "";
    const required = control.hasAttribute("required");
    const tag = control.localName;
    if (tag === "select") {
      const multi = control.hasAttribute("multiple");
      const options: ChoiceOption[] = all(control, "option").map((o) => {
        const text = (o.textContent ?? "").replace(/\s+/g, " ").trim();
        return { value: o.getAttribute("value") ?? text, label: [{ text }], checked: o.hasAttribute("selected"), disabled: o.hasAttribute("disabled") };
      });
      if (!multi && !options.some((o) => o.checked)) {
        const first = options.find((o) => !o.disabled); // a single select always has a selection
        if (first) first.checked = true;
      }
      this.#addField({ kind: "choice", name, multi, select: true, other: false, label, options, required });
      return;
    }
    if (tag === "textarea") {
      this.#addField({
        kind: "text", name, type: "textarea", multiline: true, label: label.length > 0 ? label : this.#nameLabel(name),
        value: (control.textContent ?? "").replace(/^\r?\n/, ""), placeholder: control.getAttribute("placeholder") ?? "", required,
        minLength: numberAttr(control, "minlength"), maxLength: numberAttr(control, "maxlength"), rows: numberAttr(control, "rows") ?? 4,
      });
      return;
    }
    const type = (control.getAttribute("type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS[type]) return;
    const value = control.getAttribute("value");
    if (type === "hidden") {
      if (name) this.#hidden.push([name, value ?? ""]);
      return;
    }
    if (type === "radio" || type === "checkbox") {
      const option: ChoiceOption = {
        value: value ?? "on",
        label: label.length > 0 ? label : [{ text: value ?? name }],
        checked: control.hasAttribute("checked"),
        disabled: control.hasAttribute("disabled"),
      };
      const key = `${type}\0${name}`;
      const group = this.#groups.get(key);
      if (group) {
        group.options.push(option);
        group.required ||= required;
        return;
      }
      const field: ChoiceField = { kind: "choice", name, multi: type === "checkbox", select: false, other: false, label: [], options: [option], required };
      this.#groups.set(key, field);
      this.#addField(field);
      return;
    }
    this.#addField({
      kind: "text", name, type, multiline: false, label: label.length > 0 ? label : this.#nameLabel(name), value: value ?? "",
      placeholder: control.getAttribute("placeholder") ?? "", required, min: numberAttr(control, "min"), max: numberAttr(control, "max"),
      pattern: control.getAttribute("pattern") ?? undefined, minLength: numberAttr(control, "minlength"), maxLength: numberAttr(control, "maxlength"), rows: 1,
    });
  }

  #nameLabel(name: string): FormSpan[] {
    return name ? [{ text: name.replace(/[_-]+/g, " ") }] : [];
  }

  #addField(field: FormField): void {
    this.#fields.push(field);
    this.#section.blocks.push({ kind: "field", field });
  }
}
