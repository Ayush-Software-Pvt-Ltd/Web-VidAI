// What only the server has (SPEC section 12, Server): (1) a file outside the Editing Folder is
// never served - a thumbnail that is a symlink to a file outside it, and direct requests for the
// settings file, a path with `..` and a missing file - while the page goes on working; (2) the
// access token survives a restart of the server (the same cookie still works), and a deleted
// `web-token` file makes a new token, so the old cookie gets the 401 page and the new address works;
// (3) a second `vidai-web` on the same data directory exits 0 and says where the first one is,
// while the first printed `Open VidAI Web in your browser:`.
import { copyFile, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { CHANNEL } from "../../e2e/library.mjs";
import { startSecond } from "../setups.mjs";
import { activity, row, startEditing, status } from "../ui.mjs";

const EDITED = "001 Landscape Clip";
const LINKED = "002 Landscape Twin";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "web-guards",
  title: "Asset 403 outside the Editing Folder, the token over restarts, a second start",
  timeout: 150_000,
  async run(t) {
    await t.seedLibrary([
      [EDITED, "landscape"],
      [LINKED, "landscape"],
    ]);
    let server = await t.startServer();
    const context = await t.newContext();
    const page = await t.open(server, context);
    const asset = (/** @type {string} */ p) =>
      `${server.origin}/api/asset?path=${encodeURIComponent(p)}`;

    // --- (1) Thumbnails and the Editing Folder --------------------------------------------------
    await startEditing(page, EDITED);
    await status(row(page, EDITED), "Edited", 30_000);
    const thumb = path.join(t.editing, CHANNEL, EDITED, "output", "thumbnail-1.png");
    // The same picture outside the Editing Folder, linked into another video's output folder.
    const outside = path.join(t.dir, "outside", "secret.png");
    await mkdir(path.dirname(outside), { recursive: true });
    await copyFile(thumb, outside);
    const linkedOutput = path.join(t.editing, CHANNEL, LINKED, "output");
    await mkdir(linkedOutput, { recursive: true });
    await symlink(outside, path.join(linkedOutput, "thumbnail-1.png"));
    // The library looks at the disk again when the page is opened.
    await page.reload();
    await row(page, LINKED).waitFor({ timeout: 30_000 });

    // Direct requests, with the cookie.
    const inside = await context.request.get(asset(thumb));
    t.equal(inside.status(), 200, "a thumbnail inside the Editing Folder");
    t.assert(
      (inside.headers()["content-type"] ?? "").startsWith("image/png"),
      `its content type: ${inside.headers()["content-type"]}`,
    );
    t.equal(
      (await context.request.get(asset(path.join(path.dirname(thumb), "missing.png")))).status(),
      404,
      "a missing file inside the Editing Folder",
    );
    for (const [what, target] of /** @type {const} */ ([
      ["a file outside", outside],
      [
        "the symlink in the Editing Folder that points outside",
        path.join(linkedOutput, "thumbnail-1.png"),
      ],
      ["the settings file", path.join(t.data, "settings.json")],
      ["a path that leaves the folder with ..", `${t.editing}/${CHANNEL}/../../data/settings.json`],
      ["a path that does not exist outside", path.join(t.dir, "outside", "nothing.png")],
      ["a relative path", "settings.json"],
    ])) {
      const answer = await context.request.get(asset(target));
      t.equal(answer.status(), 403, `${what} is refused`);
      t.assert(!(await answer.text()).includes("vidai-settings"), `${what}: nothing leaks`);
    }
    // Without the cookie not even the inside file.
    t.allowFailure(/\b401\b/);
    const stranger = await t.newContext();
    t.equal((await stranger.request.get(asset(thumb))).status(), 401, "no cookie, no file");

    // The page: the thumbnail of the edited video shows, the linked one is refused (403) and the
    // page shows its placeholder and goes on working.
    // The refused thumbnail is a 403 for the page, and the browser logs it as an error too.
    t.allowFailure(/api\/asset\?path=.*\(status 403\)/);
    t.allowFailure(/status of 403.*api\/asset/);
    /** @type {string[]} */
    const refused = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/asset") && response.status() === 403)
        refused.push(response.url());
    });
    await row(page, EDITED).getByRole("button", { name: EDITED, exact: true }).click();
    const panel = activity(page);
    await panel.getByRole("tab", { name: "Outputs" }).click();
    const shown = panel.getByRole("button", { name: "Open thumbnail-1.png" });
    await shown.waitFor();
    await t.waitFor(
      async () =>
        (await shown
          .locator("img")
          .evaluate((img) => /** @type {{ naturalWidth: number }} */ (img).naturalWidth)) > 0,
      "the thumbnail inside the Editing Folder to load",
    );
    await row(page, LINKED).getByRole("button", { name: LINKED, exact: true }).click();
    await panel.getByRole("tab", { name: "Outputs" }).click();
    const linked = panel.getByRole("button", { name: "Open thumbnail-1.png" });
    await linked.waitFor();
    await t.waitFor(
      () => refused.length > 0,
      "the page's request for the outside file to be refused",
    );
    t.equal(await linked.locator("img").count(), 0, "the refused thumbnail shows no picture");
    await t.shot(page, "thumbnail-refused");
    // The page goes on working: the other video, another click, the library.
    await row(page, EDITED).getByRole("button", { name: EDITED, exact: true }).click();
    await t.waitFor(
      async () =>
        (await panel
          .getByRole("button", { name: "Open thumbnail-1.png" })
          .locator("img")
          .evaluate((img) => /** @type {{ naturalWidth: number }} */ (img).naturalWidth)) > 0,
      "the first video's thumbnail again",
    );
    await row(page, LINKED).getByRole("button", { name: "Start Editing" }).waitFor();

    // --- (2) The token over restarts ------------------------------------------------------------
    const tokenFile = path.join(t.data, "web-token");
    const token = (await readFile(tokenFile, "utf8")).trim();
    t.equal(token, server.token, "web-token is the token of the printed address");
    t.equal((await stat(tokenFile)).mode & 0o777, 0o600, "web-token is owner-only");
    // The browser logs the broken event stream of the open pages and every refused reconnect.
    t.allowFailure(
      /ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/,
    );
    await server.interrupt();
    server = await t.startServer({ port: server.port });
    t.equal(server.token, token, "the token is kept over a restart");
    // The cookie of before still works, at the plain address.
    const again = await context.newPage();
    const answer = await again.goto(`${server.origin}/`);
    t.equal(answer?.status(), 200, "the old cookie after a restart");
    await row(again, EDITED).waitFor({ timeout: 30_000 });
    await again.close();

    // A deleted token file makes a new token: the old cookie is no key to the new server.
    await server.interrupt();
    await rm(tokenFile);
    server = await t.startServer({ port: server.port });
    t.assert(server.token !== token, "a deleted web-token makes a new token");
    t.equal((await readFile(tokenFile, "utf8")).trim(), server.token, "the new token is on disk");
    const old = await context.newPage();
    const refusedPage = await old.goto(`${server.origin}/`);
    t.equal(refusedPage?.status(), 401, "the old cookie with the new token");
    await old
      .getByText(/vidai-web/i)
      .first()
      .waitFor();
    await t.shot(old, "old-cookie-401");
    // The new address works and sets the new cookie.
    const fresh = await t.open(server, context);
    await row(fresh, EDITED).waitFor({ timeout: 30_000 });
    t.equal(
      (await context.cookies(server.origin)).find((c) => c.name === "vidai_web")?.value,
      server.token,
      "the cookie is the new token",
    );

    // --- (3) A second start ---------------------------------------------------------------------
    t.assert(
      server.output.some((line) => line.startsWith("Open VidAI Web in your browser: ")),
      `the first server printed the address: ${server.output.join(" | ")}`,
    );
    const second = await startSecond(server, t.data);
    t.equal(second.code, 0, "the second start exits with 0");
    const said = second.stdout.find((line) => line.includes("already running"));
    t.assert(
      said?.includes(`http://127.0.0.1:${server.port}/?token=${server.token}`),
      `the second start says where the first is: ${second.stdout.join(" | ")} ${second.stderr.join(" | ")}`,
    );
    t.assert(
      !second.stdout.some((line) => line.startsWith("Open VidAI Web in your browser:")),
      "the second start serves nothing of its own",
    );
    // The first one is untouched: same token, still serving.
    t.equal((await readFile(tokenFile, "utf8")).trim(), server.token, "the token is unchanged");
    const still = await context.newPage();
    t.equal(
      (await still.goto(`${server.origin}/`))?.status(),
      200,
      "the first server still serves",
    );
    await row(still, EDITED).waitFor({ timeout: 30_000 });
  },
};
