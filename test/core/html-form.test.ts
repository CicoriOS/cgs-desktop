import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import { collect, defaultFormData, fieldError, initialInput } from "../../src/core/html-form/data";
import { parseHtmlForm, spansText } from "../../src/core/html-form/parse";

const parse = (html: string) => parseHtmlForm(html, (h) => parseHTML(h).document as unknown as Document);

// The shape omp's own `ask` tool builds: one fieldset per question.
const ASK = `<form>
<fieldset><legend>Which database?</legend>
<label><input type="radio" name="db" value="pg" required> Postgres</label>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label></fieldset>
<fieldset><legend>Which features?</legend>
<label><input type="checkbox" name="features" value="auth"> Auth</label>
<label><input type="checkbox" name="features" value="billing"> Billing</label>
<label><input type="checkbox" name="features" value="other"> Other</label></fieldset>
<input type="hidden" name="session" value="abc">
</form>`;

test("groups radios and checkboxes by name, reads labels, defaults and hidden inputs", () => {
  const form = parse(ASK);
  expect(form.sections.map((s) => spansText(s.title))).toEqual(["Which database?", "Which features?"]);
  const [db, features] = form.fields;
  expect(db).toMatchObject({ kind: "choice", name: "db", multi: false, required: true, other: true });
  expect(db!.kind === "choice" && db!.options.map((o) => spansText(o.label))).toEqual(["Postgres", "SQLite"]);
  expect(features).toMatchObject({ multi: true, other: false }); // it already offers its own "Other"
  expect(defaultFormData(form)).toEqual({ session: "abc", db: "sqlite", features: [] });
});

test("Other text replaces a radio's value and joins a checkbox array; blank Other counts as nothing", () => {
  const form = parse(ASK);
  const inputs = form.fields.map(initialInput);
  inputs[0] = { ...inputs[0]!, checked: new Set(), other: "DuckDB" };
  inputs[1] = { ...inputs[1]!, checked: new Set([0]) };
  const { data, errors } = collect(form, inputs);
  expect(data).toEqual({ session: "abc", db: "DuckDB", features: ["auth"] });
  expect(errors.size).toBe(0);
  const blank = collect(form, [{ ...inputs[0]!, checked: new Set(), other: "  " }, inputs[1]!]);
  expect(blank.errors.get(0)).toEqual({ key: "form.required" }); // required radio left empty
  expect(blank.data.db).toBeUndefined();
});

test("text fields: numbers are numbers and constraints match omp's", () => {
  const form = parse(`<form><label>Port <input type="number" name="port" min="1" max="65535" required></label>
    <label>Mail <input type="email" name="mail"></label><label>Code <input name="code" pattern="[A-Z]{3}" minlength="3"></label>
    <textarea name="note" rows="2">hi</textarea></form>`);
  const [port, mail, code, note] = form.fields;
  expect(fieldError(port!, 0)).toEqual({ key: "form.min", params: { n: 1 } });
  expect(fieldError(port!, 70000)).toEqual({ key: "form.max", params: { n: 65535 } });
  expect(fieldError(port!, "")).toEqual({ key: "form.required" });
  expect(fieldError(mail!, "nope")).toEqual({ key: "form.email" });
  expect(fieldError(mail!, "")).toBeUndefined();
  expect(fieldError(code!, "abc")).toMatchObject({ key: "form.pattern" });
  expect(fieldError(code!, "ABC")).toBeUndefined();
  const inputs = form.fields.map(initialInput);
  inputs[0] = { ...inputs[0]!, text: "8080" };
  expect(collect(form, inputs).data).toMatchObject({ port: 8080, mail: "", code: "", note: "hi" });
});

test("a single select always has a selection and reports one value", () => {
  const form = parse(`<form><label>Env <select name="env"><option value="dev">Dev</option><option value="prod">Prod</option></select></label></form>`);
  expect(defaultFormData(form)).toEqual({ env: "dev" });
  expect(form.fields[0]).toMatchObject({ select: true, other: false });
});
