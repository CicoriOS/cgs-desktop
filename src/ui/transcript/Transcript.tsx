import { type RefObject, useLayoutEffect, useRef } from "react";
import { useClientState } from "../client-context";
import { TurnView } from "./TurnView";

const NEAR_BOTTOM_PX = 48;

/** Keeps the scroller pinned to the bottom while the user is at the bottom; scrolling up releases it. */
function usePinToBottom(root: RefObject<HTMLElement | null>, deps: unknown[]) {
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>("#scroller");
    if (!scroller) return;
    const onScroll = () => {
      pinned.current = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - NEAR_BOTTOM_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [root]);
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>("#scroller");
    if (scroller && pinned.current) scroller.scrollTop = scroller.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return pinned;
}

export function Transcript() {
  const turns = useClientState((s) => s.turns);
  const tools = useClientState((s) => s.tools);
  const session = useClientState((s) => s.sessionFile);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = usePinToBottom(ref, [turns, tools]);
  const lastSession = useRef(session);
  if (lastSession.current !== session) {
    lastSession.current = session;
    pinned.current = true; // a different session opens at its end
  }
  return (
    <div id="transcript" ref={ref}>
      {turns.map((t, i) => (
        <TurnView key={t.id} turn={t} index={i} isLast={i === turns.length - 1} tools={tools} />
      ))}
    </div>
  );
}
