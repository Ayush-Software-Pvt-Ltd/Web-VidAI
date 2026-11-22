/**
 * The session area (done): `getSession`, `login`, `logout`, `changePassword`, `setupAdmin`.
 * Behaves like `server/src/rpc/account.js`: a wrong email or password, and a disabled account,
 * all answer `invalidInput` "Email or password is wrong."; changing the password ends the
 * account's other sessions (their browsers get `session-ended`).
 */
import type { Api } from "../../api";
import { ApiError } from "../../errors";
import type { SessionInfo } from "../../types";
import type { MockCtx } from "../ctx";
import type { MockUser } from "../world";
import { nextId } from "../world";

const LOGIN_REFUSED = "Email or password is wrong.";
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const EMAIL_MAX = 254;

/** An input refusal that names its field, as the server's `invalidInput(message, field)`. */
const refusal = (message: string, field: string) => new ApiError("invalidInput", message, field);

/** Refuses with the sentence of the server's `validateEmail`, naming `field` (default `email`). */
export function validateEmail(_ctx: MockCtx, value: string, field = "email"): string {
  const email = value.trim().toLowerCase();
  if (email.length > EMAIL_MAX) {
    throw refusal(`The email address can have at most ${EMAIL_MAX} characters.`, field);
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw refusal("Enter a valid email address, like name@example.com.", field);
  }
  return email;
}

/** The same for `validatePassword`, naming `field` (default `password`). */
export function validatePassword(_ctx: MockCtx, value: string, field = "password"): string {
  const length = Array.from(value).length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw refusal(`The password must have ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`, field);
  }
  return value;
}

export function sessionInfo(ctx: MockCtx): SessionInfo {
  const user = ctx.user();
  return {
    user: user
      ? { id: user.id, email: user.email, role: user.role, mayMarkUrgent: user.mayMarkUrgent }
      : null,
    needsSetup: ctx.world.needsSetup,
    serverVersion: ctx.world.serverVersion,
  };
}

/** Signs this browser in as `user` (replacing its old session). */
function signIn(ctx: MockCtx, user: MockUser): void {
  const old = ctx.session.get();
  if (old) ctx.world.sessions.delete(old);
  const token = nextId(ctx.world, "session");
  ctx.world.sessions.set(token, { userId: user.id });
  ctx.session.set(token);
  user.lastSeenAt = ctx.clock.now();
}

export function sessionArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  return {
    getSession: () => ctx.run(() => sessionInfo(ctx)),

    login: ({ email, password }) =>
      ctx.run(() => {
        const wanted = email.trim().toLowerCase();
        const user = world.users.find((candidate) => candidate.email === wanted);
        if (!user || user.password !== password || user.disabled) {
          throw ctx.errors.invalidInput(LOGIN_REFUSED);
        }
        signIn(ctx, user);
        return sessionInfo(ctx);
      }),

    logout: () =>
      ctx.run(() => {
        ctx.requireUser();
        const token = ctx.session.get();
        if (token) world.sessions.delete(token);
        ctx.session.set(null);
        // This browser's event stream ends with its session.
        ctx.emitHere("session-ended", { reason: null });
        return null;
      }),

    changePassword: ({ currentPassword, newPassword }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        if (user.password !== currentPassword) {
          throw refusal("The current password is wrong.", "currentPassword");
        }
        user.password = validatePassword(ctx, newPassword, "newPassword");
        ctx.endSessions(user.id, { exceptToken: ctx.session.get(), reason: "passwordChanged" });
        return null;
      }),

    setupAdmin: ({ token, email, password }) =>
      ctx.run(() => {
        if (!world.needsSetup || token !== world.setupToken) {
          throw ctx.errors.forbidden("This setup address is no longer valid.");
        }
        const now = ctx.clock.now();
        const admin: MockUser = {
          id: nextId(world, "user"),
          email: validateEmail(ctx, email),
          password: validatePassword(ctx, password),
          role: "admin",
          disabled: false,
          mayMarkUrgent: true,
          createdAt: now,
          lastSeenAt: now,
        };
        world.users.push(admin);
        world.needsSetup = false;
        signIn(ctx, admin);
        return sessionInfo(ctx);
      }),
  };
}
