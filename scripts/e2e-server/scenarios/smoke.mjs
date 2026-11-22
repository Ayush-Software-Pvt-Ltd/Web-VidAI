// The smoke scenario: the whole path of a video through the real server, in a browser.
// An administrator makes an account and gives a folder on the server to that user as a channel;
// the user uploads files into the video's and the channel's upload folder, edits the video (the
// fake Claude Code), reviews it on the timeline and asks for the final render (the real renderer,
// when it can run here).
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

  await ctx.step("admin creates the user", async () => {
    await page.getByRole("button", { name: "Admin", exact: true }).click();
    await page.getByRole("button", { name: "Users", exact: true }).click();
    await page.getByRole("button", { name: "New User" }).click();
    const dialog = page.getByRole("dialog", { name: "New user" });
    await dialog.getByLabel("Email").fill(USER_EMAIL);
    await dialog.getByLabel("Password").fill(USER_PASSWORD);
    await dialog.getByRole("button", { name: "Create User" }).click();
    await expect(page.getByRole("button", { name: `Edit ${USER_EMAIL}` })).toBeVisible();
  });

  await ctx.step("admin gives the folder to the user as a channel", async () => {
    // Channels are made on the Admin, Channels page, reached through the admin navigation.
    await page
      .getByRole("navigation", { name: "Admin", exact: true })
      .getByRole("button", { name: "Channels", exact: true })
      .click();
    await page.getByRole("button", { name: "New Channel", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New Channel" });
    await dialog.getByLabel("Name").fill(CHANNEL_NAME);
    await dialog.getByRole("combobox", { name: "Owner" }).click();
    await page.getByRole("option", { name: USER_EMAIL, exact: true }).click();
    await dialog.getByRole("button", { name: "Choose…" }).click();
    // The picker browses the whole server: go to the folder the world prepared by its path.
    const picker = page.getByRole("dialog", { name: "Choose the channel's folder" });
    await picker.getByRole("button", { name: "Type a path" }).click();
    await picker.getByLabel("Path").fill(world.storage);
    await picker.getByLabel("Path").press("Enter");
    await picker.getByRole("option", { name: CHANNEL_NAME }).click();
    await picker.getByRole("button", { name: `Choose "${CHANNEL_NAME}"` }).click();
    await expect(picker).toBeHidden();
    await expect(dialog.getByTestId("channel-folder")).toContainText(world.channelDir);
    await dialog.getByRole("button", { name: "Create Channel" }).click();
    await expect(dialog).toBeHidden();
    const entry = page.getByTestId("channel-row").filter({ hasText: CHANNEL_NAME });
    await expect(entry).toContainText(USER_EMAIL);
    await expect(entry).toContainText("1 video");
    await expect(entry).toContainText(world.channelDir);
  });

  await ctx.step("admin signs out", async () => {
    await page.getByRole("button", { name: "Done" }).click();
    await signOut(page, ADMIN_EMAIL);
  });

  await ctx.step("user signs in and sees the channel but cannot make one", async () => {
    await signIn(page, base, USER_EMAIL, USER_PASSWORD);
    const sidebar = page.getByRole("navigation", { name: "Channels" });
    await expect(sidebar.getByText(CHANNEL_NAME, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Channel" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New Video" })).toHaveCount(0);
  });

  const row = page.getByRole("list", { name: "Videos" }).getByRole("listitem");

  await ctx.step("the library lists the video as not edited", async () => {
    await expect(row.getByRole("button", { name: VIDEO_FOLDER, exact: true })).toBeVisible();
    await expect(row.getByText("Not edited")).toBeVisible();
  });

  /**
   * Uploads one small file through the open Upload Files dialog and checks the list and the disk.
   * @param {string} fileName
   * @param {string} folder The `upload` folder the file must land in.
   */
  async function uploadThroughDialog(fileName, folder) {
    const dialog = page.getByRole("dialog", { name: "Upload Files" });
    await expect(dialog.getByText("Files in the folder")).toBeVisible();
    const source = path.join(world.root, "to-upload", fileName);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `end-to-end upload ${fileName}\n`);
    await dialog.getByLabel("Files to upload").setInputFiles(source);
    await expect(
      dialog
        .getByRole("region", { name: "Files in the folder" })
        .getByText(fileName, { exact: true }),
    ).toBeVisible();
    const onDisk = path.join(folder, fileName);
    if (!fs.existsSync(onDisk)) throw new Error(`the upload is missing on disk: ${onDisk}`);
    if (fs.readFileSync(onDisk, "utf8") !== `end-to-end upload ${fileName}\n`) {
      throw new Error(`the uploaded file has other content: ${onDisk}`);
    }
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
  }

  await ctx.step("user uploads a file into the video's upload folder", async () => {
    await row.getByRole("button", { name: `More for ${VIDEO_FOLDER}` }).click();
    await page.getByRole("menuitem", { name: "Upload Files" }).click();
    const dialog = page.getByRole("dialog", { name: "Upload Files" });
    await expect(dialog.getByText(`The upload folder of ${VIDEO_FOLDER}`)).toBeVisible();
    await uploadThroughDialog("notes-e2e.txt", path.join(world.videoDir, "upload"));
  });

  await ctx.step("user uploads a file into the channel's upload folder", async () => {
    await page
      .getByRole("navigation", { name: "Channels" })
      .getByRole("button", { name: `More for ${CHANNEL_NAME}` })
      .click();
    await page.getByRole("menuitem", { name: "Upload Files" }).click();
    const dialog = page.getByRole("dialog", { name: "Upload Files" });
    await expect(dialog.getByText(`The upload folder of ${CHANNEL_NAME}`)).toBeVisible();
    await uploadThroughDialog("logo-e2e.png", path.join(world.channelDir, "upload"));
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
