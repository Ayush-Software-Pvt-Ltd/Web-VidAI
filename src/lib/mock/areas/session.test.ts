import { describe, expect, it, vi } from "vitest";
import { ADMIN_EMAIL, ADMIN_PASSWORD, USER_EMAIL, USER_PASSWORD } from "../seed/session";
import { MockBackend } from "../backend";

const options = { latencyMs: 0, autoTick: false } as const;

describe("mock session area", () => {
  it("starts signed in as the admin, as a user, or signed out", async () => {
    for (const [scenarios, as, role] of [
      [["default"], undefined, "admin"],
      [["as-user"], undefined, "user"],
      [["signed-out"], undefined, null],
      [["default"], "user", "user"],
    ] as const) {
      const backend = new MockBackend({
        ...options,
        scenarios: [...scenarios],
        ...(as ? { as } : {}),
      });
      expect((await backend.getSession()).user?.role ?? null).toBe(role);
      backend.dispose();
    }
  });

  it("refuses a wrong password, an unknown email and a disabled user the same way", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["signed-out"] });
    const user = backend.world.users.find((u) => u.email === USER_EMAIL);
    if (!user) throw new Error("seed user missing");
    user.disabled = true;
    for (const input of [
      { email: ADMIN_EMAIL, password: "wrong-password" },
      { email: "nobody@example.com", password: ADMIN_PASSWORD },
      { email: USER_EMAIL, password: USER_PASSWORD },
    ]) {
      await expect(backend.login(input)).rejects.toMatchObject({
        code: "invalidInput",
        message: "Email or password is wrong.",
      });
    }
    expect((await backend.getSession()).user).toBeNull();
    backend.dispose();
  });

  it("an expired session is not announced; the next call asks to sign in", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["default"], as: "user" });
    const ended = vi.fn();
    backend.on.sessionEnded(ended);
    expect((await backend.getSession()).user?.email).toBe(USER_EMAIL);
    backend.expireSession();
    expect(ended).not.toHaveBeenCalled();
    await expect(backend.getWorkspace()).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Sign in to continue.",
    });
    expect((await backend.getSession()).user).toBeNull();
    backend.dispose();
  });

  it("logs in (email trimmed and lowercased) and out, and logout emits session-ended", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["signed-out"] });
    const ended = vi.fn();
    backend.on.sessionEnded(ended);
    const info = await backend.login({
      email: ` ${ADMIN_EMAIL.toUpperCase()} `,
      password: ADMIN_PASSWORD,
    });
    expect(info.user?.email).toBe(ADMIN_EMAIL);
    await backend.logout();
    expect(ended).toHaveBeenCalledWith({ reason: null });
    expect((await backend.getSession()).user).toBeNull();
    await expect(backend.getWorkspace()).rejects.toMatchObject({ code: "unauthenticated" });
    backend.dispose();
  });

  it("keeps two browsers separate and ends the other one when the password changes", async () => {
    const first = new MockBackend({ ...options, scenarios: ["default"], as: "admin" });
    const second = new MockBackend({
      ...options,
      scenarios: ["default"],
      as: null,
      world: first.world,
    });
    expect((await second.getSession()).user).toBeNull();
    expect((await first.getSession()).user?.role).toBe("admin");
    await second.login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const ended = vi.fn();
    first.on.sessionEnded(ended);
    await expect(
      second.changePassword({ currentPassword: "nope-nope", newPassword: "another-password" }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await second.changePassword({
      currentPassword: ADMIN_PASSWORD,
      newPassword: "another-password",
    });
    expect(ended).toHaveBeenCalledWith({ reason: "passwordChanged" });
    expect((await first.getSession()).user).toBeNull();
    expect((await second.getSession()).user?.role).toBe("admin");
    first.dispose();
    second.dispose();
  });

  it("sets up the first admin only with the right token", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["needs-setup"] });
    const session = await backend.getSession();
    expect(session).toMatchObject({ user: null, needsSetup: true });
    await expect(
      backend.setupAdmin({ token: "wrong", email: "boss@example.com", password: "long-enough-pw" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const done = await backend.setupAdmin({
      token: backend.world.setupToken,
      email: "boss@example.com",
      password: "long-enough-pw",
    });
    expect(done).toMatchObject({ needsSetup: false, user: { role: "admin" } });
    backend.dispose();
  });
});
