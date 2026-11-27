/**
 * Mirrors the visual viewport into --vvh / --vvt (see .connect-shell). iOS Safari does not resize the layout viewport for
 * the on-screen keyboard: it scrolls the visual viewport instead, which pushed the top bar out of reach and left the
 * composer under the keyboard. Following the visual viewport keeps both on screen. While pinch-zoomed the last values stay.
 */
export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  const sync = () => {
    if (vv.scale !== 1) return;
    root.setProperty("--vvh", `${vv.height}px`);
    root.setProperty("--vvt", `${vv.offsetTop}px`);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
}
