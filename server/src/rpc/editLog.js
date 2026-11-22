// The edit log function of SPEC section 14: `getEditLog`. Users read their own entries; the extra
// fields `userId` and `all` are for admins (the service refuses them for anybody else).

import { requireSession } from "./context.js";
import { boolean, integer, object, string, withDefault } from "./validate.js";

/**
 * @param {{ editLog: import("../editLog.js").EditLog }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function editLogFunctions({ editLog }) {
  const parse = object({
    before: withDefault(integer({ min: 1 }), null),
    // Above 500 is not an error: the service clamps it.
    limit: withDefault(integer({ min: 1, max: 100_000 }), null),
    userId: withDefault(string({ min: 1, max: 100 }), null),
    all: withDefault(boolean, false),
  });
  return [
    {
      name: "getEditLog",
      access: "user",
      handler(input, ctx) {
        const { user } = requireSession(ctx);
        return editLog.read(user, parse(input));
      },
    },
  ];
}
