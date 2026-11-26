// Port of omp's form data rules (html-form/data.ts). omp rejects an `ask` answer that breaks them and gives the model no second try,
// so the client enforces the same constraints before it sends anything.
import type { MessageKey } from "../../i18n";
import { type ChoiceField, type FormField, type HtmlForm, type TextField } from "./parse";

/** Submitted value of one control: text, a number for `number`/`range` inputs, or a group's checked values. */
export type HtmlFormValue = string | number | string[];
export type HtmlFormData = Record<string, HtmlFormValue>;

export interface FieldError {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** A checkbox group or multi-select of two or more options reports an array; everything else one value. */
export const isArrayChoice = (field: ChoiceField): boolean => field.multi && field.options.length > 1;

/**
 * Value a choice field contributes given its checked option indices and, when the user chose "Other", that text: it stands in for a
 * radio's value or joins a checkbox group's array. Undefined when the field contributes nothing; blank Other text counts as none.
 */
export function choiceValue(field: ChoiceField, checked: ReadonlySet<number>, other?: string): HtmlFormValue | undefined {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((o, i) => (checked.has(i) && !o.disabled ? [o.value] : []));
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}

/** A number for non-empty numeric `number`/`range` inputs, else the text. */
export function textValue(field: TextField, text: string): HtmlFormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined; // an invalid pattern is ignored, as in omp
  }
}

/** Why `value` is not an acceptable answer for `field`, or undefined when it is. Mirrors omp's `fieldError`. */
export function fieldError(field: FormField, value: HtmlFormValue | undefined): FieldError | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return { key: isArrayChoice(field) ? "form.selectOne" : "form.required" };
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? { key: "form.required" } : undefined;
  if (field.type === "number" || field.type === "range") {
    const n = Number(text);
    if (!Number.isFinite(n)) return { key: "form.number" };
    if (field.min !== undefined && n < field.min) return { key: "form.min", params: { n: field.min } };
    if (field.max !== undefined && n > field.max) return { key: "form.max", params: { n: field.max } };
  }
  if (field.minLength !== undefined && text.length < field.minLength) return { key: "form.minLen", params: { n: field.minLength } };
  if (field.maxLength !== undefined && text.length > field.maxLength) return { key: "form.maxLen", params: { n: field.maxLength } };
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return { key: "form.email" };
  if (field.type === "url" && !URL.canParse(text)) return { key: "form.url" };
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false) return { key: "form.pattern", params: { p: field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern } };
  return undefined;
}

/** Data the form submits untouched: hidden inputs, preselected options and prefilled text. */
export function defaultFormData(form: HtmlForm): HtmlFormData {
  const data: HtmlFormData = Object.create(null); // a control named `__proto__` stays an ordinary key
  for (const [name, value] of form.hidden) data[name] = value;
  for (const field of form.fields) {
    if (!field.name) continue;
    const value = field.kind === "text" ? textValue(field, field.value) : choiceValue(field, new Set(field.options.flatMap((o, i) => (o.checked ? [i] : []))));
    if (value !== undefined) data[field.name] = value;
  }
  return data;
}

/** What the user has entered into one field. */
export interface FieldInput {
  checked: ReadonlySet<number>;
  other: string;
  text: string;
}

export const initialInput = (field: FormField): FieldInput =>
  field.kind === "text"
    ? { checked: new Set(), other: "", text: field.value }
    : { checked: new Set(field.options.flatMap((o, i) => (o.checked ? [i] : []))), other: "", text: "" };

export const valueOf = (field: FormField, input: FieldInput): HtmlFormValue | undefined =>
  field.kind === "text" ? textValue(field, input.text) : choiceValue(field, input.checked, input.other);

/** Collects the submitted data and the first error of each invalid field (by index into `form.fields`). */
export function collect(form: HtmlForm, inputs: readonly FieldInput[]): { data: HtmlFormData; errors: Map<number, FieldError> } {
  const data = defaultFormData(form);
  const errors = new Map<number, FieldError>();
  form.fields.forEach((field, i) => {
    const value = valueOf(field, inputs[i] ?? initialInput(field));
    const error = fieldError(field, value);
    if (error) errors.set(i, error);
    if (!field.name) return;
    if (value === undefined) delete data[field.name]; // nothing chosen: omitted, not a stale default
    else data[field.name] = value;
  });
  return { data, errors };
}
