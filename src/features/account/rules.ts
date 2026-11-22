/**
 * The rules of an account as the server states them (docs/SPEC.md section 4, and the sentences of
 * `validatePassword` in `server/src/auth/passwords.js`), shown before the user can break them.
 * The server still decides: its refusal is shown as it words it.
 */

/** Said under every field where a new password is typed. */
export const PASSWORD_RULE = "The password must have 8 to 200 characters.";

/** Said when the two typed passwords differ (a check of the form itself, not a rule). */
export const PASSWORDS_DIFFER = "The two passwords are not the same.";

/** What a form needs of a refusal to place it: the sentence and the field the server named. */
export interface Refusal {
  message: string;
  field?: string;
}

/**
 * Which field a refusal of `setupAdmin` belongs to. The server names it (`email`, `password`);
 * without a name the sentence decides ("Enter a valid email address..." against "The password
 * must have ...").
 */
export function setupFieldOf({ message, field }: Refusal): "email" | "password" {
  if (field === "email" || field === "password") return field;
  return /password/i.test(message) ? "password" : "email";
}

/**
 * Which field a refusal of `changePassword` belongs to: the server names `currentPassword` or
 * `newPassword`; without a name the sentence decides ("The current password is wrong.").
 */
export function changeFieldOf({ message, field }: Refusal): "current" | "new" {
  if (field === "currentPassword") return "current";
  if (field === "newPassword") return "new";
  return /current/i.test(message) ? "current" : "new";
}
