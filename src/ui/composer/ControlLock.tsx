import type { Controller } from "../../core/types";
import { useT } from "../../i18n";

/**
 * Covers the composer of a conversation another client controls (ADR 0047): a red frosted pane, and a left click is the
 * takeover gesture. It is not a disabled box with a button somewhere else: clicking the conversation's input takes it.
 */
export function ControlLock({ controller, onTakeOver }: { controller: Controller; onTakeOver: () => void }) {
  const t = useT();
  const title = controller.kind === "remote" ? t("control.remote") : t("control.taken", { name: controller.name });
  const hint = t("control.takeOver");
  return (
    <div
      className="control-lock"
      role="button"
      tabIndex={0}
      aria-label={`${title}. ${hint}`}
      onClick={onTakeOver}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onTakeOver();
        }
      }}
    >
      <span className="control-lock-title">{title}</span>
      <span className="control-lock-hint">{hint}</span>
    </div>
  );
}
