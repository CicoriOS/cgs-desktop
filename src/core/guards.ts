/** The one object guard of the web client: narrows to an object whose fields are still `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
