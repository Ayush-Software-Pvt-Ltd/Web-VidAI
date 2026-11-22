// Selectors for what a user sees in VidAI (the accessible names and roles of the UI, as the
// desktop suite's harness uses them).

/** The row of a video in the library, by its folder name. */
export const row = (/** @type {import("playwright").Page} */ page, /** @type {string} */ folder) =>
  page.locator(`[role="listitem"][data-video-id$="/${folder}"]`);

/** The status pill of a row ("Editing", "Paused", "Edited" ...). */
export const pill = (/** @type {import("playwright").Locator} */ rowLocator) =>
  rowLocator.locator('[id^="row-detail-"] > span').first();

/** The activity panel. */
export const activity = (/** @type {import("playwright").Page} */ page) =>
  page.getByRole("complementary", { name: "Activity" });

/**
 * Waits until the row's status pill says `status`.
 * @param {import("playwright").Locator} rowLocator @param {string | RegExp} status
 * @param {number} [timeout]
 */
export async function status(rowLocator, status, timeout = 20_000) {
  const text = pill(rowLocator);
  const matches = (/** @type {string} */ actual) =>
    typeof status === "string" ? actual.trim() === status : status.test(actual);
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeout) {
    last = ((await text.textContent({ timeout: 1000 }).catch(() => "")) ?? "").trim();
    if (matches(last)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const shown = (await rowLocator.innerText({ timeout: 1000 }).catch(() => "")).replace(
    /\s+/g,
    " ",
  );
  throw new Error(
    `Timed out waiting for the status ${String(status)}; it is ${JSON.stringify(last)}. The row shows: ${shown}`,
  );
}

/**
 * Starts an edit from the row the way a user does: Start Editing, then the sheet's own button.
 * @param {import("playwright").Page} page @param {string} folder
 */
export async function startEditing(page, folder) {
  await row(page, folder).getByRole("button", { name: "Start Editing" }).click();
  const sheet = page.getByRole("dialog", { name: "Start Editing" });
  await sheet.getByRole("button", { name: "Start Editing" }).click();
  await sheet.waitFor({ state: "detached" });
}

/**
 * The names of the backend events the page's event stream has delivered so far, in order.
 * @param {import("playwright").Page} page @returns {Promise<string[]>}
 */
export function eventsSeen(page) {
  return page.evaluate(() => {
    /** @type {any} */
    const w = globalThis;
    return /** @type {string[]} */ (w.__vidaiEvents ?? []);
  });
}
