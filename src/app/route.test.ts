import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import type { Place, Resource } from "@/lib/store";
import type { SessionInfo } from "@/lib/types";
import { decideScreen, isSetupPath, pathOf, placeOf } from "./route";

const places: [Place, string][] = [
  [{ view: "main" }, "/"],
  [{ view: "archive" }, "/archive"],
  [{ view: "editLog" }, "/edit-log"],
  [{ view: "diskCleanup" }, "/disk"],
  [{ view: "settings", section: "channels" }, "/settings/channels"],
  [{ view: "settings", section: "appearance" }, "/settings/appearance"],
  [{ view: "settings", section: "importExport" }, "/settings/import-export"],
  [{ view: "admin", section: "users" }, "/admin/users"],
  [{ view: "admin", section: "system" }, "/admin/system"],
  [{ view: "timeline", videoId: "ch1/My Video 1" }, "/timeline/ch1%2FMy%20Video%201"],
];

describe("paths", () => {
  it.each(places)("pathOf and placeOf agree for %j", (place, path) => {
    expect(pathOf(place)).toBe(path);
    expect(placeOf(path)).toEqual(place);
  });

  it("ignores a trailing slash and rejects unknown paths", () => {
    expect(placeOf("/archive/")).toEqual({ view: "archive" });
    for (const path of [
      "/nope",
      "/admin",
      "/admin/nope",
      "/settings/importExport",
      "/timeline/",
      "/timeline/%E0%A4%A",
      "/timeline/noslash",
      "/admin/users/x",
    ]) {
      expect(placeOf(path)).toBeNull();
    }
  });

  it("knows the setup path", () => {
    expect(isSetupPath("/setup")).toBe(true);
    expect(isSetupPath("/setup/")).toBe(true);
    expect(isSetupPath("/")).toBe(false);
  });
});

const ready = (data: SessionInfo): Resource<SessionInfo> => ({
  data,
  status: "ready",
  error: null,
});
const info = (user: SessionInfo["user"], needsSetup = false): SessionInfo => ({
  user,
  needsSetup,
  serverVersion: "1",
});
const admin = { id: "u1", email: "admin@example.com", role: "admin", mayMarkUrgent: true } as const;

describe("decideScreen", () => {
  it("is loading, then fatal when the session cannot be read", () => {
    expect(decideScreen({ data: null, status: "loading", error: null }, "main")).toEqual({
      kind: "loading",
    });
    const error = new ApiError("io", "down");
    expect(decideScreen({ data: null, status: "error", error }, "main")).toEqual({
      kind: "fatal",
      error,
    });
  });

  it("asks for sign in, or for the setup when no admin exists", () => {
    expect(decideScreen(ready(info(null)), "main")).toEqual({ kind: "signIn" });
    expect(decideScreen(ready(info(null, true)), "main")).toEqual({ kind: "setup" });
  });

  it("shows the view for a signed-in user", () => {
    expect(decideScreen(ready(info(admin)), "archive")).toEqual({ kind: "archive" });
  });
  it("shows every view as it is, and never the setup to someone who is signed in", () => {
    for (const view of [
      "main",
      "settings",
      "admin",
      "archive",
      "editLog",
      "diskCleanup",
      "timeline",
    ] as const) {
      expect(decideScreen(ready(info(admin, true)), view)).toEqual({ kind: view });
    }
  });

  it("keeps showing the session it has while it is read again", () => {
    expect(decideScreen({ ...ready(info(admin)), status: "loading" }, "main")).toEqual({
      kind: "main",
    });
  });
});
