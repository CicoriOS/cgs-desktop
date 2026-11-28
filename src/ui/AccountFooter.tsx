import { Settings } from "lucide-react";
import { useT } from "../i18n";
import { badgeText, percentText, planTimeText, planTitle, usedPercent } from "./account";
import { avatarColor, avatarLetter } from "./avatar";
import { useClientState } from "./client-context";
import { updateBadge, useUpdaterStatus } from "../desktop/updater";
import { desktop } from "./desktop";
import { FEATURES } from "./features";
import { NATIVE_PROVIDERS, type PreviewSignIns } from "./provider-preview";
import { UsageMeter } from "./UsageMeter";

export function Avatar({ name, url }: { name: string; url?: string }) {
  return url ? (
    <img className="avatar" src={url} alt="" />
  ) : (
    <span className="avatar" style={{ background: avatarColor(name) }} aria-hidden="true">
      {avatarLetter(name)}
    </span>
  );
}

/**
 * The bottom of the sidebar: the CGS balance and plan, then who is signed in (picture and name) with the settings button on the right.
 * Settings remains reachable even when the host has no account.
 */
export function AccountFooter({ now, onOpenSettings, previewSignIns }: { now: number; onOpenSettings: () => void; previewSignIns?: PreviewSignIns }) {
  const t = useT();
  const account = useClientState((s) => s.account);
  const update = useUpdaterStatus();
  const loading = account === undefined && desktop?.host !== undefined;
  const sub = account?.subscriptions[0];
  const percent = sub ? usedPercent(sub) : 0;
  const when = sub ? planTimeText(sub, now) : "";
  const gear = FEATURES.settings && (
    <button type="button" className="gear" title={t("side.settings")} aria-label={t("side.settings")} onClick={onOpenSettings}>
      <Settings className="i" />
      {/* ADR 0046 §6: the update is only announced here; installing stays a user action in the settings screen. */}
      {updateBadge(update) ? <span className="gear-dot" aria-hidden="true" data-update-badge /> : null}
    </button>
  );

  return (
    <>
      {previewSignIns && NATIVE_PROVIDERS.map(({ id, name, logo, plan }) => previewSignIns[id] ? (
        <div className="side-provider-preview" key={id}>
          <span className="providers-brand"><img src={`${import.meta.env.BASE_URL}${logo}`} alt="" />{name}</span>
          <small>{plan} · {t("set.providers.previewLabel")}</small>
        </div>
      ) : null)}
      {account && (
        <div id="usage" className={account.stale ? "stale" : undefined} title={account.stale ? t("acct.stale") : undefined}>
          <div className="usage-head">
            <span className="usage-badge">{badgeText(account)}</span>
            <span className="usage-plan">{planTitle(account)}</span>
            {account.stale && <i className="usage-stale" aria-label={t("acct.stale")} />}
          </div>
          <div className="usage-line">
            <span className="usage-balance">
              {t("acct.balance")} <span className="usage-value">{account.balance || "—"}</span>
            </span>
            {sub && <span className="usage-pct usage-value">{sub.unlimited ? t("acct.unlimited") : percentText(percent)}</span>}
          </div>
          {sub && !sub.unlimited && (
            <UsageMeter used={percent} label={sub.planTitle || t("acct.subscription")} />
          )}
          {sub && (
            <div className="usage-meta">
              <span className="usage-value">{sub.unlimited ? t("acct.used", { used: sub.usedDisplay || String(sub.amountUsed) }) : `${sub.usedDisplay || sub.amountUsed} / ${sub.totalDisplay || sub.amountTotal}`}</span>
              {when && <span>{when}</span>}
            </div>
          )}
        </div>
      )}
      {(account || FEATURES.settings) && (
        <div id="side-user">
          {account ? (
            <>
              <Avatar name={account.username} url={account.avatarUrl} />
              <span className="user-name" title={account.username}>
                {account.username}
              </span>
            </>
          ) : loading ? (
            // The desktop is signed in by the time it shows the app; the snapshot just has not arrived yet.
            <>
              <span className="avatar skeleton" aria-hidden="true" />
              <span className="user-name"><span className="skeleton skeleton-name" role="status" aria-label={t("acct.loading")} /></span>
            </>
          ) : (
            <span className="user-name">{t("side.settings")}</span>
          )}
          {gear}
        </div>
      )}
    </>
  );
}
