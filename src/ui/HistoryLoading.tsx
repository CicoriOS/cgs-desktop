import { useT } from "../i18n";
import { useClientState } from "./client-context";

/** A session's history is on its way: a large purple ring breathes in the middle of the empty page, or small in the corner when a saved copy is already showing. */
export function HistoryLoading() {
  const t = useT();
  const loading = useClientState((s) => s.loading);
  const covering = useClientState((s) => s.turns.length === 0);
  if (!loading) return null;
  return (
    <div className={covering ? "history-loading" : "history-loading corner"} role="status" aria-label={t("loading.history")} title={t("loading.history")}>
      <span className="orb" />
    </div>
  );
}
