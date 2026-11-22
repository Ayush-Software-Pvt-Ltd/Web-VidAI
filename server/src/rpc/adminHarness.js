// Admin harness settings (docs/SPEC.md sections 5 and 14): the four setups, their addresses, keys,
// models and efforts, the test request, and the read-only view every user gets. Every setter
// answers with the whole screen (`HarnessAdminState`). Keys go in and never come out: the screen
// only has "saved" and the last 4 characters.

import { boolean, object, optional, string } from "./validate.js";

/** @typedef {import("../../../src/lib/wire/harness.ts").HarnessAdminState} HarnessAdminState */

/** Any text is read by the setter that knows its rules; here only the type and a sane size. */
const text = string({ max: 2000 });
const option = string({ max: 40 });

/**
 * @param {ReturnType<typeof import("../agents/setupsService.js").createSetupsService>} service
 * @param {{ usage: ReturnType<typeof import("../agents/opencode/usage.js").createUsageService> }} extra
 * @returns {import("./index.js").RpcFunction[]}
 */
export function adminHarnessFunctions(service, { usage }) {
  /**
   * A setter: validates the input, applies the change, answers with the whole screen.
   * @template T
   * @param {string} name
   * @param {(raw: unknown) => T} parse
   * @param {(input: T) => Promise<void>} apply
   * @returns {import("./index.js").RpcFunction}
   */
  const setter = (name, parse, apply) => ({
    name,
    access: "admin",
    async handler(raw) {
      await apply(parse(raw));
      return service.adminState();
    },
  });

  return [
    { name: "adminGetHarness", access: "admin", handler: () => service.adminState() },

    setter("adminSetSetup", object({ setup: string({ max: 40 }) }), ({ setup }) =>
      service.setSetup(setup),
    ),

    setter("adminSetApiBaseUrl", object({ option, baseUrl: optional(text) }), (input) =>
      service.setBaseUrl(input.option, input.baseUrl ?? null),
    ),

    setter("adminSetApiKey", object({ option, key: string({ max: 4000 }) }), (input) =>
      service.setKey(input.option, input.key),
    ),

    setter("adminClearApiKey", object({ option }), (input) => service.clearKey(input.option)),

    setter("adminSetApiModel", object({ option, model: optional(text) }), (input) =>
      service.setModel(input.option, input.model ?? null),
    ),

    setter(
      "adminSetApiEffort",
      object({ option, model: text, effort: optional(string({ max: 40 })) }),
      (input) => service.setEffort(input.option, input.model, input.effort ?? null),
    ),

    // The model and effort of the Claude subscription (it has no address or key).
    setter(
      "adminSetModelSelection",
      object({ model: optional(text), effort: optional(string({ max: 40 })) }),
      (input) => service.setClaudeSelection(input.model ?? null, input.effort ?? null),
    ),

    {
      name: "adminGetApiModels",
      access: "admin",
      handler(raw) {
        const input = object({ option, refresh: optional(boolean) })(raw);
        return service.apiModels(input.option, input.refresh ?? false);
      },
    },

    {
      name: "adminTestApi",
      access: "admin",
      handler(raw) {
        const input = object({ option })(raw);
        return service.testApi(input.option);
      },
    },

    // What every signed-in user may see of the harness, read-only (SPEC section 5).
    { name: "getHarness", access: "user", handler: () => service.publicView() },

    // Can new edits start? An admin is told where to fix it, anybody else to ask an admin.
    {
      name: "getReadiness",
      access: "user",
      handler(_raw, ctx) {
        const admin = ctx.session?.user.role === "admin";
        return service.checkReadiness({ audience: admin ? "admin" : "user" });
      },
    },

    // The OpenCode Go quota, cached unless `refresh`.
    {
      name: "getOpencodeUsage",
      access: "user",
      handler(raw) {
        const input = object({ refresh: optional(boolean) })(raw ?? {});
        return input.refresh === true ? usage.refresh() : usage.usage();
      },
    },
  ];
}
