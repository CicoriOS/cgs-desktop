import { type ReactNode, useMemo, useRef, useState } from "react";
import { collect, type FieldError, type FieldInput, initialInput } from "../../core/html-form/data";
import { type ChoiceField, type FormBlock, type FormField, type FormSpan, parseHtmlForm, type TextField } from "../../core/html-form/parse";
import { useT } from "../../i18n";
import { cx } from "../format";

function Spans({ spans }: { spans: readonly FormSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        const parts = s.text.split("\n").flatMap((line, k) => (k ? [<br key={`b${k}`} />, line] : [line]));
        if (s.style === "code") return <code key={i}>{parts}</code>;
        if (s.style === "strong") return <strong key={i}>{parts}</strong>;
        if (s.style === "em") return <em key={i}>{parts}</em>;
        return <span key={i}>{parts}</span>;
      })}
    </>
  );
}

const SAFE_IMAGE = /^(https?:|data:image\/(png|jpe?g|gif|webp);)/i;
const INPUT_TYPES = new Set(["text", "number", "range", "email", "url", "date", "time", "datetime-local", "tel", "password", "search"]);

function Block({ block }: { block: Exclude<FormBlock, { kind: "field" }> }) {
  switch (block.kind) {
    case "text":
      return block.heading ? <h4 className="f-h"><Spans spans={block.spans} /></h4> : <p><Spans spans={block.spans} /></p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return <Tag>{block.items.map((it, i) => <li key={i}><Spans spans={it} /></li>)}</Tag>;
    }
    case "pre":
      return <pre>{block.text}</pre>;
    case "table":
      return (
        <div className="tbl">
          <table>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => (r < block.headerRows ? <th key={c}><Spans spans={cell} /></th> : <td key={c}><Spans spans={cell} /></td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return SAFE_IMAGE.test(block.src) ? <img className="f-img" alt={block.alt} src={block.src} /> : <p className="muted">{block.alt}</p>;
    case "svg":
      return <img className="f-img" alt={block.alt} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.markup)}`} />; // an <img> never runs scripts
  }
}

function ErrorLine({ error }: { error?: FieldError }) {
  const t = useT();
  return error ? <div className="f-err">{t(error.key, error.params)}</div> : null;
}

function ChoiceView({ field, input, onChange, error }: { field: ChoiceField; input: FieldInput; onChange: (i: FieldInput) => void; error?: FieldError }) {
  const t = useT();
  const label = field.label.length > 0 ? <div className="f-label"><Spans spans={field.label} /></div> : null;
  if (field.select) {
    const selected = [...input.checked];
    return (
      <div className="f-field">
        {label}
        <select
          multiple={field.multi}
          value={field.multi ? selected.map(String) : String(selected[0] ?? "")}
          onChange={(e) => onChange({ ...input, checked: new Set(Array.from(e.target.selectedOptions, (o) => Number(o.value))) })}
        >
          {field.options.map((o, i) => <option key={i} value={i} disabled={o.disabled}>{o.label.map((s) => s.text).join("")}</option>)}
        </select>
        <ErrorLine error={error} />
      </div>
    );
  }
  const toggle = (i: number) => {
    if (field.multi) {
      const next = new Set(input.checked);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      onChange({ ...input, checked: next });
    } else onChange({ ...input, checked: new Set([i]), other: "" });
  };
  return (
    <div className="f-field">
      {label}
      {field.options.map((o, i) => (
        <label key={i} className={cx("f-opt", o.disabled && "off")}>
          <input type={field.multi ? "checkbox" : "radio"} name={field.name || undefined} checked={input.checked.has(i)} disabled={o.disabled} onChange={() => toggle(i)} />
          <span><Spans spans={o.label} /></span>
        </label>
      ))}
      {field.other && (
        <label className="f-opt f-other">
          <span>{t("form.other")}</span>
          <input
            type="text"
            value={input.other}
            placeholder={t("form.otherPlaceholder")}
            onChange={(e) => onChange({ ...input, other: e.target.value, checked: field.multi ? input.checked : e.target.value ? new Set() : input.checked })}
          />
        </label>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function TextView({ field, input, onChange, error }: { field: TextField; input: FieldInput; onChange: (i: FieldInput) => void; error?: FieldError }) {
  const common = { value: input.text, placeholder: field.placeholder || undefined, onChange: (e: { target: { value: string } }) => onChange({ ...input, text: e.target.value }) };
  return (
    <div className="f-field">
      {field.label.length > 0 && <div className="f-label"><Spans spans={field.label} /></div>}
      {field.multiline ? (
        <textarea rows={field.rows} maxLength={field.maxLength} {...common} />
      ) : (
        <input type={INPUT_TYPES.has(field.type) ? field.type : "text"} min={field.min} max={field.max} maxLength={field.maxLength} {...common} />
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * The `ask` tool's HTML form drawn natively. The page never injects the model's HTML: it is parsed into a model (omp's own rules)
 * and rendered from React elements. Constraints are enforced here because omp fails the whole call on one bad value.
 */
export function FormDialog({ html, onSubmit, onCancel }: { html: string; onSubmit: (data: Record<string, string | number | string[]>) => void; onCancel: () => void }) {
  const t = useT();
  const form = useMemo(() => {
    try {
      return parseHtmlForm(html);
    } catch {
      return undefined;
    }
  }, [html]);
  const [inputs, setInputs] = useState<FieldInput[]>(() => form?.fields.map(initialInput) ?? []);
  const [errors, setErrors] = useState<Map<number, FieldError>>(new Map());
  const root = useRef<HTMLFormElement>(null);

  if (!form) {
    return (
      <div className="dlg">
        <p>{t("dialog.badForm")}</p>
        <div className="dlg-btns"><button type="button" onClick={onCancel}>{t("form.cancel")}</button></div>
      </div>
    );
  }

  const index = new Map<FormField, number>(form.fields.map((f, i) => [f, i]));
  const set = (i: number) => (next: FieldInput) => setInputs((cur) => cur.map((x, k) => (k === i ? next : x)));
  const submit = () => {
    const r = collect(form, inputs);
    setErrors(r.errors);
    if (r.errors.size) {
      requestAnimationFrame(() => root.current?.querySelector(".f-err")?.scrollIntoView({ block: "nearest" }));
      return;
    }
    onSubmit(r.data);
  };

  return (
    <form
      ref={root}
      className="dlg"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <div className="dlg-title">{t("form.title")}</div>
      <div className="dlg-body">
        {form.sections.map((sec, si) => {
          const body: ReactNode[] = sec.blocks.map((b, bi) => {
            if (b.kind !== "field") return <Block key={bi} block={b} />;
            const i = index.get(b.field)!;
            const input = inputs[i] ?? initialInput(b.field);
            return b.field.kind === "choice"
              ? <ChoiceView key={bi} field={b.field} input={input} onChange={set(i)} error={errors.get(i)} />
              : <TextView key={bi} field={b.field} input={input} onChange={set(i)} error={errors.get(i)} />;
          });
          return sec.fieldset ? (
            <fieldset key={si}>
              {sec.title.length > 0 && <legend><Spans spans={sec.title} /></legend>}
              {body}
            </fieldset>
          ) : (
            <div key={si}>{body}</div>
          );
        })}
      </div>
      <div className="dlg-btns">
        <button type="button" onClick={onCancel}>{t("form.cancel")}</button>
        <button type="submit" className="primary">{t("form.submit")}</button>
      </div>
    </form>
  );
}
