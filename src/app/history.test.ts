import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupApp } from "@/test/app";
import { bindHistory } from "./history";

const settle = () => act(async () => {});

/** Goes back or forward and waits for the `popstate` jsdom sends for it. */
async function travel(direction: "back" | "forward") {
  await act(async () => {
    const popped = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    if (direction === "back") window.history.back();
    else window.history.forward();
    await popped;
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("bindHistory", () => {
  it("pushes an entry for a navigation, and Back and Forward move the store", async () => {
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    const length = window.history.length;
    act(() => {
      app.store.getState().setView("archive");
    });
    await settle();
    expect(window.location.pathname).toBe("/archive");
    expect(window.history.length).toBe(length + 1);
    act(() => {
      app.store.getState().openAdmin("queue");
    });
    await settle();
    expect(window.location.pathname).toBe("/admin/queue");

    await travel("back");
    expect(app.store.getState().view).toBe("archive");
    expect(window.location.pathname).toBe("/archive");
    await travel("back");
    expect(app.store.getState().view).toBe("main");
    await travel("forward");
    expect(app.store.getState().view).toBe("archive");
    // Moving by Back and Forward pushes nothing new.
    expect(window.history.length).toBe(length + 2);
    stop();
  });

  it("pushes the timeline and settings places with their paths", async () => {
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    const video = app.video("Serum");
    act(() => {
      app.store.getState().showTimeline(video.id);
    });
    await settle();
    expect(window.location.pathname).toBe(`/timeline/${encodeURIComponent(video.id)}`);
    act(() => {
      app.store.getState().openSettings({ section: "importExport" });
    });
    await settle();
    expect(window.location.pathname).toBe("/settings/import-export");
    stop();
  });

  it("keeps the query string of the page", async () => {
    window.history.replaceState(null, "", "/?scenario=busy");
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    act(() => {
      app.store.getState().setView("editLog");
    });
    await settle();
    expect(window.location.pathname + window.location.search).toBe("/edit-log?scenario=busy");
    stop();
  });

  it("shows the place of the address after a reload", async () => {
    window.history.replaceState(null, "", "/archive");
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    expect(app.store.getState().view).toBe("archive");
    expect(window.location.pathname).toBe("/archive");
    stop();
  });

  it("corrects an unknown address to the library without a new entry", async () => {
    window.history.replaceState(null, "", "/nowhere/at/all");
    const length = window.history.length;
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    expect(app.store.getState().view).toBe("main");
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(length);
    stop();
  });

  it("sends a person who is not an admin from an admin address to the library", async () => {
    window.history.replaceState(null, "", "/admin/users");
    const app = await setupApp(["default"], { user: "user" });
    const stop = bindHistory(app.store);
    expect(app.store.getState().view).toBe("main");
    expect(window.location.pathname).toBe("/");
    stop();
  });

  it("leads a deep link opened signed out through sign in to the place asked for", async () => {
    window.history.replaceState(null, "", "/settings/appearance");
    const app = await setupApp(["signed-out"], { user: null });
    const stop = bindHistory(app.store);
    // Signed out: the address stays and the store does not move.
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(app.store.getState().view).toBe("main");
    await act(async () => {
      await app.store.getState().login("admin@example.com", "admin-password");
    });
    await settle();
    expect(app.store.getState().view).toBe("settings");
    expect(app.store.getState().settingsSection).toBe("appearance");
    expect(window.location.pathname).toBe("/settings/appearance");
    stop();
  });

  it("keeps the address of a session that ended and goes home after a deliberate sign out", async () => {
    window.history.replaceState(null, "", "/archive");
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    expect(app.store.getState().view).toBe("archive");

    act(() => {
      app.store.getState().sessionEnded("passwordChanged");
    });
    await settle();
    expect(window.location.pathname).toBe("/archive");
    await act(async () => {
      await app.store.getState().login("admin@example.com", "admin-password");
    });
    await settle();
    expect(app.store.getState().view).toBe("archive");

    await act(async () => {
      await app.store.getState().logout();
    });
    await settle();
    expect(window.location.pathname).toBe("/");
    stop();
  });

  it("keeps /setup with its token while setup is due, and drops it once an admin exists", async () => {
    window.history.replaceState(null, "", "/setup#secret");
    const app = await setupApp(["needs-setup"], { user: null });
    const stop = bindHistory(app.store);
    expect(window.location.pathname + window.location.hash).toBe("/setup#secret");
    await act(async () => {
      await app.store
        .getState()
        .setupAdmin(app.backend.world.setupToken, "boss@example.com", "long-enough-pw");
    });
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    expect(app.store.getState().view).toBe("main");
    stop();
  });

  it("replaces /setup when nothing needs setting up", async () => {
    window.history.replaceState(null, "", "/setup#old");
    const app = await setupApp(["signed-out"], { user: null });
    const stop = bindHistory(app.store);
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    stop();
  });

  it("stops listening when unbound", async () => {
    const app = await setupApp(["default"]);
    const stop = bindHistory(app.store);
    stop();
    act(() => {
      app.store.getState().setView("archive");
    });
    await settle();
    expect(window.location.pathname).toBe("/");
  });
});
