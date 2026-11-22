// The smoke scenario: the whole path of a video through the real server, in a browser.
// An administrator makes an account, the user adds a channel, edits a video (the fake Claude
// Code), reviews it on the timeline and asks for the final render (the real renderer, when it
// can run here).
import fs from "node:fs";
import path from "node:path";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  CHANNEL_NAME,
  USER_EMAIL,
  USER_PASSWORD,
  VIDEO_FOLDER,
} from "../world.mjs";
import { expect, signIn, signOut } from "../ui.mjs";

export const name = "smoke";

/** @param {import("../run.mjs").Context} ctx */
export async function run(ctx) {
  const { base, world } = ctx;
  const page = await ctx.newPage();
  const project = path.join(world.videoDir, "output", `${VIDEO_FOLDER}.hf`);

  await ctx.step("admin signs in", () => signIn(page, base, ADMIN_EMAIL, ADMIN_PASSWORD));

  await ctx.step("admin opens Admin and allows the storage folder", async () => {
    await page.getByRole("button", { name: "Admin", exact: true }).click();
    await page.getByRole("button", { name: "Storage", exact: true }).click();
    await page.getByLabel("Full path of a folder to add").fill(world.storage);
    await page.getByRole("button", { name: "Add Folder" }).click();
    await expect(
      page.getByRole("button", { name: `Remove ${world.storage}`, exact: true }),
    ).toBeVisible();
  });

  await ctx.step("admin creates the user", async () => {
    await page.getByRole("button", { name: "Users", exact: true }).click();
    await page.getByRole("button", { name: "New User" }).click();
    const dialog = page.getByRole("dialog", { name: "New user" });
    await dialog.getByLabel("Email").fill(USER_EMAIL);
    await dialog.getByLabel("Password").fill(USER_PASSWORD);
    await dialog.getByRole("button", { name: "Create User" }).click();
    await expect(page.getByRole("button", { name: `Edit ${USER_EMAIL}` })).toBeVisible();
  });

  await ctx.step("admin signs out", async () => {
    await page.getByRole("button", { name: "Done" }).click();
    await signOut(page, ADMIN_EMAIL);
  });

  await ctx.step("user signs in", () => signIn(page, base, USER_EMAIL, USER_PASSWORD));

  await ctx.step("user adds the channel from the storage folder", async () => {
    await page
      .getByRole("navigation", { name: "Channels" })
      .getByRole("button", { name: "New Channel", exact: true })
      .click();
    await page
      .getByRole("main")
      .getByRole("button", { name: "New Channel", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New Channel" });
    await dialog.getByLabel("Channel name").fill(CHANNEL_NAME);
    await dialog.getByRole("radio", { name: "Existing folder" }).click();
    await dialog.getByRole("button", { name: "Choose Folder…" }).click();
    const picker = page.getByRole("dialog", { name: "Choose the channel's folder" });
    // The place is named after the folder (the admin added the storage folder by its path).
    await picker
      .getByRole("navigation", { name: "Places" })
      .getByRole("button", { name: path.basename(world.storage), exact: true })
      .click();
    await picker.getByRole("option", { name: CHANNEL_NAME }).click();
    await picker.getByRole("button", { name: `Choose "${CHANNEL_NAME}"` }).click();
    await dialog.getByRole("button", { name: "Create Channel" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: CHANNEL_NAME })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
  });

  const row = page.getByRole("list", { name: "Videos" }).getByRole("listitem");

  await ctx.step("the library lists the video as not edited", async () => {
    await expect(row.getByRole("button", { name: VIDEO_FOLDER, exact: true })).toBeVisible();
    await expect(row.getByText("Not edited")).toBeVisible();
  });

  await ctx.step("user starts the edit", async () => {
    await row.getByRole("button", { name: "Start Editing" }).click();
    const dialog = page.getByRole("dialog", { name: "Start Editing" });
    await dialog.getByRole("button", { name: "Start Editing" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByRole("button", { name: "Stop Editing" })).toBeVisible();
  });

  await ctx.step("the edit finishes", async () => {
    await expect(row.getByText(/^Edited/)).toBeVisible({ timeout: 120_000 });
    await expect(row.getByRole("button", { name: "Review" })).toBeVisible();
    if (!fs.existsSync(path.join(project, "index.html"))) {
      throw new Error(`the agent's project is missing: ${project}/index.html`);
    }
  });

  await ctx.step("the timeline opens", async () => {
    await row.getByRole("button", { name: "Review" }).click();
    await expect(
      page.getByRole("heading", { name: `${CHANNEL_NAME} / ${VIDEO_FOLDER}`, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^A-roll Hook, starts 00:00:00/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  });

  if (!world.renderer.ok) {
    ctx.skip("final render", `the renderer cannot run here: ${world.renderer.note}`);
    return;
  }
  const final = `${VIDEO_FOLDER}_final_v1.mp4`;
  await ctx.step("user renders the final video", async () => {
    await page.getByRole("button", { name: "Render Final", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Render Final" });
    await dialog.getByRole("button", { name: "Render Final" }).click();
    await expect(page.getByText(final, { exact: true })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole("link", { name: `Download ${final}` })).toBeVisible();
    if (!fs.existsSync(path.join(world.videoDir, "output", final))) {
      throw new Error(`the render is missing on disk: output/${final}`);
    }
  });
}
