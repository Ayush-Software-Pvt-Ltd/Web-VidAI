// The admin's System page (docs/SPEC.md sections 5 and 14): `adminGetSystem` reads everything,
// `adminPrepareToolkit` starts Prepare (section 7) and answers at once with its state; the page
// follows the steps through the `system-changed` event.

import { notReady } from "../errors.js";

/**
 * @param {object} deps
 * @param {{ view(): Promise<import("../../../src/lib/wire/system.ts").SystemView> }} deps.system
 * @param {{
 *   start(): import("../../../src/lib/wire/system.ts").PrepareState,
 *   installError(): string | null,
 * }} deps.toolkit What the toolkit module offers: start Prepare (never waits) and why the
 *   toolkit could not be installed.
 * @returns {import("./index.js").RpcFunction[]}
 */
export function adminSystemFunctions({ system, toolkit }) {
  return [
    { name: "adminGetSystem", access: "admin", handler: () => system.view() },
    {
      name: "adminPrepareToolkit",
      access: "admin",
      handler() {
        const error = toolkit.installError();
        if (error !== null) {
          throw notReady(`The toolkit is not installed, so it cannot be prepared. ${error}`);
        }
        return toolkit.start();
      },
    },
  ];
}
