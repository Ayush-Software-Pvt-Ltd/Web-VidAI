// The RPC registry (docs/SPEC.md sections 3, 4 and 14): `POST /api/rpc/<name>` ends in `call`.
//
// EXTENSION POINT: every area of the server adds its functions with `rpc.register(group)`,
// where `group` is a list of `{ name, access, handler }` (see `RpcFunction`). Write the
// functions of one area in one file that exports `xxxFunctions(deps): RpcFunction[]`, check
// input with the validators of `./validate.js`, and register that list where the server is
// wired together. `call` does the access checks, so a handler never repeats them; a handler of
// a `user` or `admin` function may use `requireSession(ctx)` to get its session typed.

import { AppError, toAppError } from "../errors.js";
import { accountFunctions } from "./account.js";
import { adminSettingsFunctions } from "./adminSettings.js";
import { adminUsersFunctions } from "./adminUsers.js";

/** @typedef {import("./context.js").RpcContext} RpcContext */
/** @typedef {import("./context.js").Session} Session */

/**
 * @typedef {object} RpcFunction
 * @property {string} name As in SPEC section 14, e.g. `adminListUsers`.
 * @property {"public" | "user" | "admin"} access `public`: no session needed; `user`: any
 *   signed-in account; `admin`: signed in with the admin role, `forbidden` otherwise.
 * @property {(input: unknown, ctx: RpcContext) => unknown | Promise<unknown>} handler Returns
 *   the JSON answer (`null` when there is nothing to say) or throws an `AppError`.
 */

/**
 * @typedef {object} Events What the RPC functions need of the event bus.
 * @property {(event: { event: string, payload: unknown, userId: string | null, admins: boolean }) => void} emit
 *   `userId` set: that user's sessions; `admins`: also every admin; both null/false: every
 *   signed-in session.
 * @property {(userId: string) => void} closeUser Ends that user's open event streams (called
 *   after their sessions ended).
 */

/**
 * @typedef {object} Hooks Later modules react to account changes. Each is awaited before the
 *   account change completes.
 * @property {(userId: string) => void | Promise<void>} onUserRemoved Called before the account
 *   and its rows are deleted (the job engine stops and removes the user's jobs).
 * @property {(userId: string) => void | Promise<void>} [afterUserRemoved] Called after the
 *   account and its rows are deleted (the server's own folders of its videos are removed).
 * @property {(userId: string) => void | Promise<void>} onUserDisabled Called after the account
 *   is disabled and its sessions ended.
 * @property {(userId: string) => number} activeJobCount Jobs shown in the admin's account list.
 * @property {(clean: Partial<import("../../../src/lib/wire.ts").AdminSettings>) => void | Promise<void>} beforeSettingsChange
 *   Called with the checked change of the admin settings before it is stored; a module that
 *   refuses it throws an `AppError` (storage: a folder that holds channels cannot be removed).
 */

/**
 * @typedef {object} RpcDeps Everything is injected; nothing here is global.
 * @property {import("../db/open.js").Database} db
 * @property {ReturnType<typeof import("../db/users.js").createUsersRepo>} users
 * @property {ReturnType<typeof import("../auth/sessions.js").createSessions>} sessions
 * @property {ReturnType<typeof import("../settings.js").createSettings>} settings
 * @property {ReturnType<typeof import("../secrets.js").createSecrets>} secrets
 * @property {ReturnType<typeof import("../auth/throttle.js").createThrottle>} throttle
 * @property {ReturnType<typeof import("../auth/setup.js").createSetup>} setup
 * @property {Events} events
 * @property {import("../db/open.js").Clock} clock
 * @property {string} version
 * @property {Partial<Hooks>} [hooks]
 */

const ACCESS_LEVELS = ["public", "user", "admin"];

/**
 * @param {RpcDeps} deps
 */
export function createRpc(deps) {
  /** @type {Map<string, RpcFunction>} */
  const functions = new Map();

  /**
   * Adds functions to the registry.
   * @param {readonly RpcFunction[]} group
   */
  function register(group) {
    for (const fn of group) {
      if (!ACCESS_LEVELS.includes(fn.access)) {
        throw new Error(`The RPC function ${fn.name} has no valid access level.`);
      }
      if (functions.has(fn.name))
        throw new Error(`The RPC function ${fn.name} is registered twice.`);
      functions.set(fn.name, fn);
    }
  }

  register(accountFunctions(deps));
  register(adminUsersFunctions(deps));
  register(adminSettingsFunctions(deps));

  return {
    register,

    /** The registered names, for tests and the route table. @returns {string[]} */
    names() {
      return [...functions.keys()];
    },

    /**
     * Runs one function after checking who is asking.
     * @param {string} name
     * @param {unknown} input
     * @param {RpcContext} ctx
     * @returns {Promise<unknown>}
     * @throws {AppError}
     */
    async call(name, input, ctx) {
      const fn = functions.get(name);
      if (!fn) throw new AppError("notFound", `There is no function called "${name}".`);
      if (fn.access !== "public") {
        if (!ctx.session) throw new AppError("unauthenticated", "Sign in to continue.");
        if (fn.access === "admin" && ctx.session.user.role !== "admin") {
          throw new AppError("forbidden", "Only an admin can do this.");
        }
      }
      try {
        return await fn.handler(input ?? {}, ctx);
      } catch (error) {
        throw toAppError(error);
      }
    },
  };
}
