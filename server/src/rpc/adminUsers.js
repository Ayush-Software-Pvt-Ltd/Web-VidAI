// Account administration (docs/SPEC.md section 4): adminListUsers, adminCreateUser,
// adminUpdateUser, adminDeleteUser. Only an admin creates, edits and deletes accounts, and the
// last enabled admin can be neither deleted, disabled nor made a user.

import { conflict, notFound } from "../errors.js";
import { hashPassword, validateEmail, validatePassword } from "../auth/passwords.js";
import { requireSession } from "./context.js";
import { endSessions } from "./sessionEnd.js";
import { boolean, object, oneOf, optional, string, withDefault } from "./validate.js";

/** @typedef {import("../../../src/lib/wire.ts").UserAccount} UserAccount */

const NO_SUCH_ACCOUNT = "This account does not exist.";
const ROLES = /** @type {const} */ (["admin", "user"]);

/**
 * @param {import("./index.js").RpcDeps} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function adminUsersFunctions(deps) {
  const { db, users } = deps;
  const hooks = {
    onUserRemoved: async () => {},
    afterUserRemoved: async () => {},
    onUserDisabled: async () => {},
    activeJobCount: () => 0,
    ...deps.hooks,
  };

  /** @param {import("../db/users.js").UserRecord} user @returns {UserAccount} */
  const toAccount = (user) => ({
    id: user.id,
    email: user.email,
    role: user.role,
    disabled: user.disabled,
    mayMarkUrgent: user.mayMarkUrgent,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    activeJobs: hooks.activeJobCount(user.id),
  });

  // The rules below read, wait (hashing, hooks) and then write; running these functions one
  // after another keeps two admins from racing each other past the last-admin rule.
  let tail = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  function serialized(work) {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @param {import("../db/users.js").UserRecord} user */
  const isEnabledAdmin = (user) => user.role === "admin" && !user.disabled;

  return [
    {
      name: "adminListUsers",
      access: "admin",
      handler: () => users.list().map(toAccount),
    },

    {
      name: "adminCreateUser",
      access: "admin",
      async handler(input) {
        const fields = object({
          email: string({ max: 1000 }),
          password: string({ max: 100000 }),
          role: withDefault(oneOf(ROLES), "user"),
          // New accounts may mark Urgent unless the admin says otherwise (SPEC section 8).
          mayMarkUrgent: withDefault(boolean, true),
        })(input);
        const email = validateEmail(fields.email);
        const hash = await hashPassword(validatePassword(fields.password));
        return toAccount(
          users.create({
            email,
            passwordHash: hash,
            role: fields.role,
            mayMarkUrgent: fields.mayMarkUrgent,
          }),
        );
      },
    },

    {
      name: "adminUpdateUser",
      access: "admin",
      handler(input, ctx) {
        const session = requireSession(ctx);
        const fields = object({
          id: string({ min: 1, max: 64 }),
          email: optional(string({ max: 1000 })),
          password: optional(string({ max: 100000 })),
          role: optional(oneOf(ROLES)),
          disabled: optional(boolean),
          mayMarkUrgent: optional(boolean),
        })(input);

        return serialized(async () => {
          const target = users.byId(fields.id);
          if (!target) throw notFound(NO_SUCH_ACCOUNT);
          const email = fields.email === undefined ? undefined : validateEmail(fields.email);
          const passwordHash =
            fields.password === undefined
              ? undefined
              : await hashPassword(validatePassword(fields.password));

          const updated = db.transaction(() => {
            const current = users.byId(fields.id);
            if (!current) throw notFound(NO_SUCH_ACCOUNT);
            const role = fields.role ?? current.role;
            const disabled = fields.disabled ?? current.disabled;
            // Includes an admin editing themself: nobody may remove the last way to administer.
            if (isEnabledAdmin(current) && !(role === "admin" && !disabled)) {
              if (users.countEnabledAdmins() <= 1) {
                throw role !== "admin"
                  ? conflict(
                      "The last admin cannot be made a user. Make another account an admin first.",
                      "role",
                    )
                  : conflict(
                      "The last admin cannot be disabled. Make another account an admin first.",
                      "disabled",
                    );
              }
            }
            return users.update(fields.id, {
              email,
              passwordHash,
              role: fields.role,
              disabled: fields.disabled,
              mayMarkUrgent: fields.mayMarkUrgent,
            });
          });
          if (!updated) throw notFound(NO_SUCH_ACCOUNT);

          const isSelf = updated.id === session.user.id;
          const newlyDisabled = updated.disabled && !target.disabled;
          if (newlyDisabled) {
            endSessions(deps, updated.id, { reason: "disabled" });
            if (isSelf) ctx.setSessionCookie(null);
            await hooks.onUserDisabled(updated.id);
          } else if (passwordHash !== undefined) {
            // Whoever else is signed in as this account must sign in again; an admin changing
            // their own password stays signed in here.
            endSessions(deps, updated.id, {
              exceptId: isSelf ? session.id : null,
              reason: "passwordChanged",
            });
          }
          return toAccount(updated);
        });
      },
    },

    {
      name: "adminDeleteUser",
      access: "admin",
      handler(input, ctx) {
        const session = requireSession(ctx);
        const { id } = object({ id: string({ min: 1, max: 64 }) })(input);

        return serialized(async () => {
          const target = users.byId(id);
          if (!target) throw notFound(NO_SUCH_ACCOUNT);
          const refuseLast = () => {
            if (isEnabledAdmin(target) && users.countEnabledAdmins() <= 1) {
              throw conflict(
                "The last admin cannot be deleted. Make another account an admin first.",
              );
            }
          };
          refuseLast();

          // Sessions first so the person cannot act while the hook stops their jobs; the hook
          // runs while the account and its jobs still exist. Files on disk are never touched.
          endSessions(deps, id, { reason: "removed" });
          if (id === session.user.id) ctx.setSessionCookie(null);
          await hooks.onUserRemoved(id);
          db.transaction(() => {
            refuseLast();
            users.delete(id);
          });
          await hooks.afterUserRemoved?.(id);
          return null;
        });
      },
    },
  ];
}
