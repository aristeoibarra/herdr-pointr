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
