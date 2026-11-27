import { toneOf } from "./account";

export function UsageMeter({ used, label }: { used: number; label: string }) {
  return (
    <div className="usage-bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(used)} data-tone={toneOf(used)}>
      <i style={{ width: `${used}%` }} />
    </div>
  );
}
