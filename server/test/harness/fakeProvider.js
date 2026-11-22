// A local stand-in for a model provider: a node:http server on port 0 that records every request
// and answers as the handler says. Not a test file.

import http from "node:http";

/**
 * @typedef {object} Seen
 * @property {string} method
 * @property {string} url Path and query.
 * @property {http.IncomingHttpHeaders} headers
 * @property {string} body
 *
 * @typedef {{ status: number, body?: string, headers?: Record<string, string> }} Answer
 */

/**
 * @param {(seen: Seen) => Answer | Promise<Answer>} handler
 * @returns {Promise<{ url: string, seen: Seen[], close: () => Promise<void> }>}
 */
export async function startProvider(handler) {
  /** @type {Seen[]} */
  const seen = [];
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const entry = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const answer = await handler(entry);
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(answer.body ?? "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
