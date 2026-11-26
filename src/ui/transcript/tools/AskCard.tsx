import type { ToolCall } from "../../../core/types";
import { useT } from "../../../i18n";
import { useClientState } from "../../client-context";
import { Ring } from "../../ring";
import { resultText } from "./ToolCard";

interface Answer {
  name?: string;
  question?: string;
  answer?: string;
}

/** omp puts each question and the answer the user gave into the result's `details.answers`. */
function answersOf(call: ToolCall): Answer[] {
  const d = call.result?.details as { answers?: Answer[] } | undefined;
  return Array.isArray(d?.answers) ? d.answers : [];
}

/** The ask tool as a conversation piece: what the model asked and what the user answered. */
export function AskCard({ call }: { call: ToolCall }) {
  const t = useT();
  const streaming = useClientState((s) => s.run.streaming);
  const level = useClientState((s) => s.thinking.resolved);
  const answers = answersOf(call);
  const state = call.status === "fail" ? "fail" : call.status === "ok" ? "ok" : streaming ? "work" : "idle";
  return (
    <div className={`ask-card${call.status === "fail" ? " err" : ""}`}>
      <div className="ask-head">
        <Ring small state={state} level={level} />
        <span>{t("ask.title")}</span>
      </div>
      {!call.result && <div className="ask-wait">{t("ask.waiting")}</div>}
      {call.result && answers.length > 0 && (
        <dl>
          {answers.map((a, i) => (
            <div key={a.name ?? i} className="ask-qa">
              <dt>{a.question || a.name}</dt>
              <dd>{a.answer?.trim() ? a.answer : <span className="muted">{t("ask.noAnswer")}</span>}</dd>
            </div>
          ))}
        </dl>
      )}
      {call.result && answers.length === 0 && <pre className="ask-raw">{resultText(call) || t("tool.empty")}</pre>}
    </div>
  );
}
