/** Below this width the sidebar is a drawer over the conversation (keep in step with the media query in base.css). */
export const MOBILE_QUERY = "(max-width: 760px)";
export const isMobile = () => typeof matchMedia === "function" && matchMedia(MOBILE_QUERY).matches;
