// Account functions (docs/SPEC.md sections 2 and 4): getSession, login, logout, changePassword,
// setupAdmin.

import { AppError, invalidInput } from "../errors.js";
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  dummyVerify,
  hashPassword,
  validatePassword,
  verifyPassword,
} from "../auth/passwords.js";
import { requireSession } from "./context.js";
import { endSessions } from "./sessionEnd.js";
import { object, string } from "./validate.js";

/** @typedef {import("../../../src/lib/wire.ts").SessionInfo} SessionInfo */

const LOGIN_REFUSED = "Email or password is wrong.";

/** @param {number} ms */
function rateLimited(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return new AppError(
    "rateLimited",
    `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  );
}

/**
 * @param {import("./index.js").RpcDeps} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function accountFunctions(deps) {
  const { users, sessions, throttle, setup, version } = deps;

  /**
   * @param {string | null} userId
   * @returns {SessionInfo}
   */
  function sessionInfo(userId) {
    const user = userId === null ? null : users.byId(userId);
    return {
      user:
        user && !user.disabled
          ? { id: user.id, email: user.email, role: user.role, mayMarkUrgent: user.mayMarkUrgent }
          : null,
      needsSetup: setup.needsSetup(),
      serverVersion: version,
    };
  }

  return [
    {
      name: "getSession",
      access: "public",
      // Never throws for a signed-out visitor: the page asks this first to decide what to show.
      handler: (_input, ctx) => sessionInfo(ctx.session?.user.id ?? null),
    },

    {
      name: "login",
      access: "public",
      async handler(input, ctx) {
        const { email: rawEmail, password } = object({
          email: string({ max: 1000 }),
          password: string({ max: 100000 }),
        })(input);
        // Not validated like an account email: a malformed one gets the same answer as a wrong one.
        const email = rawEmail.trim().toLowerCase().slice(0, EMAIL_MAX);
        const who = { email, address: ctx.address };

        const wait = throttle.check(who);
        if (wait > 0) throw rateLimited(wait);

        const user = users.byEmail(email);
        // The same scrypt work whether or not the email exists, so timing reveals nothing.
        // (A password longer than any account can have is refused without hashing all of it.)
        const matches =
          user && [...password].length <= PASSWORD_MAX
            ? await verifyPassword(password, user.passwordHash)
            : await dummyVerify();
        if (!user || !matches || user.disabled) {
          throttle.failure(who);
          throw invalidInput(LOGIN_REFUSED);
        }

        throttle.success(who);
        // Signing in again replaces this browser's old session instead of leaving it behind.
        if (ctx.session) sessions.end(ctx.session.id);
        const { token } = sessions.create(user.id, ctx);
        ctx.setSessionCookie(token);
        return sessionInfo(user.id);
      },
    },

    {
      name: "logout",
      access: "user",
      handler(_input, ctx) {
        const session = requireSession(ctx);
        sessions.end(session.id);
        ctx.setSessionCookie(null);
        // This browser's stream ends with its session; the account's other sessions keep theirs.
        if (sessions.countOfUser(session.user.id) === 0) deps.events.closeUser(session.user.id);
        return null;
      },
    },

    {
      name: "changePassword",
      access: "user",
      async handler(input, ctx) {
        const session = requireSession(ctx);
        const { currentPassword, newPassword } = object({
          currentPassword: string({ max: 100000 }),
          newPassword: string({ max: 100000 }),
        })(input);
        const user = users.byId(session.user.id);
        if (!user) throw new AppError("unauthenticated", "Sign in to continue.");

        // A stolen session must not be able to guess the current password without limit.
        const who = { email: user.email, address: ctx.address };
        const wait = throttle.check(who);
        if (wait > 0) throw rateLimited(wait);
        if (!(await verifyPassword(currentPassword, user.passwordHash))) {
          throttle.failure(who);
          throw invalidInput("The current password is wrong.", "currentPassword");
        }
        throttle.success(who);

        const hash = await hashPassword(validatePassword(newPassword, "newPassword"));
        users.update(user.id, { passwordHash: hash });
        endSessions(deps, user.id, { exceptId: session.id, reason: "passwordChanged" });
        return null;
      },
    },

    {
      name: "setupAdmin",
      access: "public",
      async handler(input, ctx) {
        const { token, email, password } = object({
          token: string({ max: 200 }),
          email: string({ max: 1000 }),
          password: string({ max: 100000 }),
        })(input);
        const admin = await setup.setupAdmin(token, email, password);
        // The person who just made the account is signed in with it.
        const { token: sessionToken } = sessions.create(admin.id, ctx);
        ctx.setSessionCookie(sessionToken);
        return sessionInfo(admin.id);
      },
    },
  ];
}
