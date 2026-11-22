/**
 * Seed of the admin area. The default world needs nothing more than its two accounts and the
 * settings of `seed/empty.ts`; `addUser` gives a test or a scenario more accounts.
 */
import type { MockUser, World } from "../world";
import { nextId } from "../world";

export function seedAdmin(_world: World, _now: number): void {}

/** Adds an account (any role, disabled or not); the password is plain text, this is a fake. */
export function addUser(
  world: World,
  spec: Partial<Omit<MockUser, "id">> & { email: string },
  now: number = Date.now(),
): MockUser {
  const user: MockUser = {
    id: nextId(world, "user"),
    password: "password-for-tests",
    role: "user",
    disabled: false,
    mayMarkUrgent: true,
    createdAt: now - 86_400_000,
    lastSeenAt: null,
    ...spec,
  };
  world.users.push(user);
  return user;
}
