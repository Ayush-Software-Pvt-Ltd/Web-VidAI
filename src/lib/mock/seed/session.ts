/** Seed of the session area: one admin and one user, and the first browser signed in as the admin. */
import type { World } from "../world";

export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "admin-password";
export const USER_EMAIL = "user@example.com";
export const USER_PASSWORD = "user-password";
export const ADMIN_ID = "admin00000000000000000000000001";
export const USER_ID = "user000000000000000000000000001";

export function seedSession(world: World, now: number): void {
  world.users.push(
    {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      role: "admin",
      disabled: false,
      mayMarkUrgent: true,
      createdAt: now - 90 * 86_400_000,
      lastSeenAt: now - 60_000,
    },
    {
      id: USER_ID,
      email: USER_EMAIL,
      password: USER_PASSWORD,
      role: "user",
      disabled: false,
      mayMarkUrgent: false,
      createdAt: now - 30 * 86_400_000,
      lastSeenAt: now - 3_600_000,
    },
  );
}
