// What the scenarios do in the browser, by the accessible names a person (or a screen reader)
// sees: roles and labels, never CSS selectors.
import { expect } from "playwright/test";

export { expect };

/** @typedef {import("playwright").Page} Page */

/**
 * Opens the app and signs in.
 * @param {Page} page
 * @param {string} base
 * @param {string} email
 * @param {string} password
 */
export async function signIn(page, base, email, password) {
  await page.goto(base);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Channels" })).toBeVisible();
}

/**
 * Signs out through the account menu (the main page of the library shows it).
 * @param {Page} page
 * @param {string} email
 */
export async function signOut(page, email) {
  await page.getByRole("button", { name: `Account of ${email}` }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to VidAI" })).toBeVisible();
}
