// The server is stopped with Ctrl+C while an edit runs (SPEC section 12, Server and User interface
// in the browser): it pauses the edit and exits 0, the page says that VidAI is not running; when the
// server is started again on the same port and data directory the page reloads by itself, shows the
// paused edit, and Continue Editing works.
import { activity, row, startEditing, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "reconnect",
  title: "Ctrl+C pauses the edit, the page says VidAI is not running, reloads when it is back",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    await t.fakeSet("scenario", "live");
    const server = await t.startServer();
    const page = await t.open(server);
    const video = row(page, VIDEO);
    await startEditing(page, VIDEO);
    await status(video, "Editing");
    await t.waitFake(`started.${VIDEO}`);
    await t.fakeRemove(`started.${VIDEO}`);
    await page.evaluate(() => {
      /** @type {any} */
      const w = globalThis;
      w.__notReloaded = true;
    });

    // The browser logs the broken event stream and every refused reconnect as errors.
    t.allowFailure(
      /ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/,
    );
    const ended = await server.interrupt();
    t.equal(ended.code, 0, "the exit status of Ctrl+C");
    t.assert(
      server.output.some((line) => /Pausing 1 running or waiting edit/.test(line)),
      `the server says it pauses the edit: ${JSON.stringify(server.output.slice(-5))}`,
    );

    // The page says that VidAI is not running, and keeps trying.
    const notice = page
      .getByRole("alert")
      .filter({ has: page.getByRole("heading", { name: "VidAI is not running" }) });
    await notice
      .getByRole("heading", { name: "VidAI is not running" })
      .waitFor({ timeout: 30_000 });
    await notice.getByText("This page reconnects by itself.", { exact: false }).waitFor();
    await t.shot(page, "not-running");

    // The server again, on the same port and data: the page reloads by itself.
    const again = await t.startServer({ port: server.port });
    t.equal(again.port, server.port, "the port after the restart");
    t.equal(again.token, server.token, "the token is kept");
    await notice.waitFor({ state: "detached", timeout: 30_000 });
    t.equal(
      await page.evaluate(() => {
        /** @type {any} */
        const w = globalThis;
        return w.__notReloaded === true;
      }),
      false,
      "the page reloaded by itself",
    );
    await video.waitFor();
    await status(video, "Paused", 30_000);
    await video.getByRole("button", { name: "Continue Editing" }).waitFor();
    await video.getByRole("button", { name: VIDEO, exact: true }).click();
    await activity(page).getByText("Paused. Press Continue Editing to resume.").waitFor();
    await t.shot(page, "paused-after-restart");

    // Continue works, and the edit completes.
    await video.getByRole("button", { name: "Continue Editing" }).click();
    await status(video, "Editing", 30_000);
    await t.waitFake(`started.${VIDEO}`);
    await t.release(VIDEO);
    await status(video, "Edited", 30_000);
    const calls = (await t.fakeCalls()).filter((c) => c.sid !== "");
    const [first, second] = calls;
    t.assert(
      calls.length === 2 && first?.sid === second?.sid && second?.mode === "resume",
      `the session was resumed by the new server: ${JSON.stringify(calls.map((c) => [c.mode, c.sid]))}`,
    );
  },
};
