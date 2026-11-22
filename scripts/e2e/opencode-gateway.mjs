// The local stand-in for the OpenCode gateway, shared by the scenarios of edits on OpenCode
// (19-anthropic-api, 21-opencode-program, 25-no-claude-opencode2, 27-program-uninstalled): it answers like the gateway's source does, with the key as
// a bearer token, and records what it was asked, without the key.
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const KEY = "oc_sk_e2e_SECRET_9c4d";
export const MODELS = [
  { type: "model", id: "glm-5.3", display_name: "GLM-5.3", created_at: "2026-09-01T00:00:00Z" },
  { type: "model", id: "kimi-k3", display_name: "Kimi K3", created_at: "2026-09-01T00:00:00Z" },
  {
    type: "model",
    id: "minimax-m3",
    display_name: "MiniMax-M3",
    created_at: "2026-09-01T00:00:00Z",
  },
];

/**
 * The local stand-in for the OpenCode gateway, answering like its source does: the model list
 * (in two pages, so paging is used), the Messages endpoint and the Go usage endpoint, each with
 * the key as a bearer token. It records what it was asked, without the key.
 * With `keyless` set it answers like a local model server that needs no key: a request with no key is served too.
 * @type {{ server: import("node:http").Server | null, base: string, requests: { method: string, path: string, bearer: "key" | "other" | "none", body: any }[], keyless: boolean }}
 */
export const gateway = { server: null, base: "", requests: [], keyless: false };

export async function startGateway() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // The key as a bearer token (OpenCode Go, OpenAI form) or as `x-api-key` (the Anthropic
      // form of `anthropicApi`, SPEC section 7a).
      const auth = req.headers.authorization ?? "";
      const apiKey = String(req.headers["x-api-key"] ?? "");
      const bearer =
        auth === `Bearer ${KEY}` || apiKey === KEY ? "key" : auth || apiKey ? "other" : "none";
      /** @type {any} */
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      gateway.requests.push({ method: req.method ?? "", path: url.pathname, bearer, body });
      /** @param {number} status @param {unknown} json */
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const refused = () =>
        send(401, {
          type: "error",
          error: { type: "authentication_error", message: "Invalid credential" },
        });
      if (req.method === "GET" && url.pathname === "/inference/go/anthropic/v1/models") {
        if (bearer === "other") return refused();
        const after = url.searchParams.get("after_id");
        const page = after ? MODELS.slice(2) : MODELS.slice(0, 2);
        return send(200, {
          data: page,
          has_more: !after,
          first_id: page[0]?.id,
          last_id: page.at(-1)?.id,
        });
      }
      if (req.method === "POST" && url.pathname === "/inference/go/anthropic/v1/messages") {
        if (bearer !== "key" && !(gateway.keyless && bearer === "none")) return refused();
        return send(200, {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body?.model,
          content: [{ type: "text", text: "H" }],
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            opencode: { billing_source: "go", allowance: 0.0001 },
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/inference/go/v1/usage") {
        if (bearer !== "key")
          return send(401, {
            type: "error",
            error: { type: "AuthError", message: "Unauthorized" },
          });
        const at = (/** @type {number} */ hours) =>
          new Date(Date.now() + hours * 3_600_000).toISOString();
        return send(200, {
          usage: {
            rolling: { status: "ok", percent: 41, resetsAt: at(3) },
            weekly: { status: "ok", percent: 17, resetsAt: at(80) },
            monthly: { status: "ok", percent: 9, resetsAt: at(400) },
          },
        });
      }
      send(404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  gateway.server = server;
  gateway.base = `http://127.0.0.1:${port}/inference/go/anthropic`;
}

/** Every file under `dir`, recursively. @param {string} dir @returns {Promise<string[]>} */
export async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/** Stops the stand-in, if it runs, and forgets what it was asked. */
export async function stopGateway() {
  const server = gateway.server;
  gateway.server = null;
  gateway.requests = [];
  gateway.keyless = false;
  if (server) {
    await new Promise((resolve) => {
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    });
  }
}
