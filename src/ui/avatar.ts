// The placeholder picture for an account without one, the same colour and letter the CGS web console draws (new-api `web/src/lib/avatar.ts`),
// so a user sees one avatar everywhere.

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

export function avatarColor(name: string): string {
  const hash = hashString(name);
  return `hsl(${hash % 360} ${54 + (hash % 8)}% ${52 + ((hash >> 4) % 8)}%)`;
}

export const avatarLetter = (name: string): string => name.trim().charAt(0).toUpperCase() || "?";
