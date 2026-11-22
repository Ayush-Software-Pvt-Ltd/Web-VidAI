// Access (SPEC section 12, Server): the tokenized address redirects to `/` and sets the cookie, the
// plain address works afterwards, a browser without the cookie gets the 401 page, a request with a
// foreign Origin (or Host) is 403.
import { row } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "access",
  title: "Tokenized address, cookie, 401 without it, 403 for a foreign Origin",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const server = await t.startServer();
    t.assert(server.token.length === 64, `the token is 32 bytes of hex: ${server.token}`);

    // The tokenized address redirects to `/` (the token leaves the address bar) and the app shows.
    const context = await t.newContext();
    const page = await t.open(server, context);
    t.equal(page.url(), `${server.origin}/`, "the address after the token redirect");
    await row(page, VIDEO).waitFor({ timeout: 30_000 });
    t.equal(await page.title(), "VidAI", "the page title");
    const cookie = (await context.cookies(server.origin)).find((c) => c.name === "vidai_web");
    t.assert(cookie, "the cookie vidai_web is set");
    if (cookie) {
      t.equal(cookie.value, server.token, "the cookie value is the token");
      t.assert(cookie.httpOnly, "the cookie is HttpOnly");
      t.equal(cookie.sameSite, "Strict", "the cookie's SameSite");
      t.equal(cookie.path, "/", "the cookie's path");
    }
    await t.shot(page, "app-after-token");

    // A second visit to the plain address works (the cookie).
    const second = await context.newPage();
    const answer = await second.goto(`${server.origin}/`);
    t.equal(answer?.status(), 200, "the plain address with the cookie");
    await row(second, VIDEO).waitFor({ timeout: 30_000 });
    await second.close();

    // A browser without the cookie gets the 401 page that says what to do.
    // The browser also logs an unauthorized page load as a console error.
    t.allowFailure(/\b401\b/);
    const stranger = await t.newContext();
    const lost = await stranger.newPage();
    const refused = await lost.goto(`${server.origin}/`);
    t.equal(refused?.status(), 401, "the plain address without the cookie");
    await lost
      .getByText(/vidai-web/i)
      .first()
      .waitFor({ timeout: 5_000 });
    t.assert(
      !(await lost.content()).includes(server.token),
      "the 401 page does not give the token away",
    );
    await t.shot(lost, "unauthorized-page");
    // A wrong token is no better, and sets no cookie.
    const wrong = await lost.goto(`${server.origin}/?token=${"0".repeat(64)}`);
    t.equal(wrong?.status(), 401, "a wrong token");
    t.equal((await stranger.cookies(server.origin)).length, 0, "a wrong token sets no cookie");
    // The API says the same in JSON.
    const api = await stranger.request.post(`${server.origin}/api/invoke/get_settings`, {
      data: {},
    });
    t.equal(api.status(), 401, "the API without the cookie");
    t.equal((await api.json()).kind, "unauthorized", "the API's 401 body");

    // A foreign Origin or Host is 403, also with the cookie.
    for (const [what, headers] of /** @type {const} */ ([
      ["a foreign Origin", { Origin: "http://evil.example" }],
      ["a foreign Origin on the right host name", { Origin: "http://127.0.0.1:1" }],
      ["a foreign Host", { Host: "evil.example" }],
    ])) {
      const forbidden = await context.request.post(`${server.origin}/api/invoke/get_settings`, {
        data: {},
        headers,
      });
      t.equal(forbidden.status(), 403, `${what}, with the cookie`);
    }
    const own = await context.request.post(`${server.origin}/api/invoke/get_settings`, {
      data: {},
      headers: { Origin: server.origin },
    });
    t.assert(own.status() !== 403, `the right Origin is let through (status ${own.status()})`);
  },
};
