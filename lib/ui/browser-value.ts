import { useSyncExternalStore } from "react";

/**
 * ==========================================
 * useBrowserValue
 * ==========================================
 *
 * Reads a value that exists on the CLIENT ONLY — `localStorage`, a `data-*` attribute the pre-paint
 * bootstrap already applied, `window` — without a hydration mismatch and without a
 * `setState`-in-an-effect.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three dashboard preferences (the sidebar's collapsed flag, the selected accent and the selected
 * chart palette) and two theme-switcher labels (the current appearance, whether dark mode is on) are
 * all "ask the browser after hydration" values. The obvious implementation is:
 *
 *     const [value, setValue] = useState(default);
 *     useEffect(() => setValue(readFromBrowser()), []);
 *
 * It is correct, but it is a state update inside an effect, which React's lint rules flag as a
 * cascading render. This hook is the same read expressed as a proper external store:
 * `useSyncExternalStore` calls the server snapshot for the initial render and the client snapshot
 * immediately after, so the first client pass matches the server's markup exactly (no mismatch) and
 * the real value arrives in the same commit that would have followed the effect.
 *
 * The subscribe function is intentionally inert. These values cannot change without this tab
 * mutating them, and every mutation already goes through the caller's own state, so there is nothing
 * to subscribe to — a `storage` listener would only matter for the browser's cross-tab change
 * event, which is not a behaviour either caller had.
 *
 * `read` must return a primitive or a stable reference: `useSyncExternalStore` compares consecutive
 * snapshots with `Object.is`, so a fresh object each call would loop.
 */
const neverChanges = () => () => {
    /* no external notification source */
};

export function useBrowserValue<T>(read: () => T, serverValue: T): T {
    return useSyncExternalStore(neverChanges, read, () => serverValue);
}
