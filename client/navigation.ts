/** Where the page is, for filing threads, and when a single-page app moves. */

/**
 * The page key a thread is filed under within one dev server: the path,
 * without a trailing slash, plus the route when the app routes on the
 * fragment — a hash-router app would otherwise pile every thread onto "/".
 */
export function pageKey(loc: Location = location): string {
  let path = loc.pathname || "/";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const hash = loc.hash.slice(1);
  if (hash.startsWith("/") || hash.startsWith("!/")) path += `#${hash.split("?")[0] ?? ""}`;
  return path;
}

export const NAVIGATE_EVENT = "pointr:navigate";
const HOOK_KEY = "__pointrHistory";

/**
 * Makes client-side navigation observable. History has no event for
 * pushState, so both methods are wrapped — once per page, guarded on window:
 * the widget can be mounted more than once, and wrappers stacked on each
 * other would fire the event several times per navigation.
 */
export function installHistoryHook(): void {
  if (Reflect.get(window, HOOK_KEY) === true) return;
  Reflect.set(window, HOOK_KEY, true);
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>): void {
      original.apply(this, args);
      window.dispatchEvent(new Event(NAVIGATE_EVENT));
    };
  }
}
