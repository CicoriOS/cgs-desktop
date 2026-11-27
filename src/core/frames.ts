// The omp RPC commands that only read a conversation (ADR 0047): a stream that does not control the conversation may
// send exactly these. The host keeps the same list in cgscli `packages/connect/src/remote/host/index.ts`; neither
// repository can import the other, so both carry a copy and a test in cgscli compares them.
export const READ_ONLY_FRAMES: Record<string, true> = {
  get_state: true,
  get_entries: true,
  get_messages: true,
  get_session_stats: true,
  get_subagents: true,
  get_subagent_messages: true,
  // Changes only which frames omp forwards to this stream, not the session.
  set_subagent_subscription: true,
  get_model_picker: true,
  get_available_thinking_levels: true,
  get_btw_history: true,
};

/** Whether one raw frame (a JSON object) is in READ_ONLY_FRAMES. */
export function isReadOnlyFrame(frame: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return false;
  }
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && Object.hasOwn(READ_ONLY_FRAMES, value.type);
}
