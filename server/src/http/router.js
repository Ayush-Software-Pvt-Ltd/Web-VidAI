// Route matching (the route forms are documented at `Route` in types.js).

/**
 * @typedef {{ kind: "found", route: import("./types.js").Route, params: Record<string, string> }
 *   | { kind: "method", allow: string[] }
 *   | { kind: "none" }} Match
 */

/**
 * @param {string} value
 * @returns {string | null} Null when the escapes are malformed.
 */
function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * @param {import("./types.js").Route} route
 * @param {string} pathname
 * @returns {Record<string, string> | null}
 */
function matchPath(route, pathname) {
  const pattern = route.path;
  if (pattern instanceof RegExp) {
    const found = pattern.exec(pathname);
    if (!found) return null;
    return Object.fromEntries(
      Object.entries(found.groups ?? {}).filter((entry) => entry[1] !== undefined),
    );
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    if (!pathname.startsWith(prefix)) return null;
    const rest = decode(pathname.slice(prefix.length));
    return rest === null ? null : { rest };
  }
  return pathname === pattern ? {} : null;
}

/**
 * @param {import("./types.js").Route[]} routes
 */
export function createRouter(routes) {
  return {
    /**
     * @param {string} method
     * @param {string} pathname
     * @returns {Match}
     */
    match(method, pathname) {
      /** @type {Set<string>} */
      const allow = new Set();
      /** @type {Match | null} */
      let get = null;
      for (const route of routes) {
        const params = matchPath(route, pathname);
        if (!params) continue;
        allow.add(route.method);
        if (route.method === method) return { kind: "found", route, params };
        if (method === "HEAD" && route.method === "GET") get ??= { kind: "found", route, params };
      }
      if (get) return get;
      if (allow.size === 0) return { kind: "none" };
      if (allow.has("GET")) allow.add("HEAD");
      return { kind: "method", allow: [...allow] };
    },
  };
}
