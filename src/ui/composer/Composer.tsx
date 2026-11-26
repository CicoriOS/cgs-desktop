import type { Actions, ClientState } from "../../core/types";

/** `empty`: the blank page (centered greeting above it); `chat`: pinned under the transcript. */
export function Composer(_: { state: ClientState; actions: Actions; variant: "empty" | "chat" }) {
  return <div id="composer" />;
}
