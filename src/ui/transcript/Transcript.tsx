import type { Actions, ClientState } from "../../core/types";

export function Transcript(_: { state: ClientState; actions: Actions }) {
  return <div id="transcript" />;
}
