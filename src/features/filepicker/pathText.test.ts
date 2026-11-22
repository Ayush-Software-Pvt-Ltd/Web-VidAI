import { describe, expect, it } from "vitest";
import {
  crumbsBelow,
  crumbsOf,
  isAbsolutePath,
  isInsidePath,
  leafName,
  normalizeTypedPath,
  parentOf,
  samePath,
} from "./pathText";

describe("crumbsOf", () => {
  it("cuts a path below the root", () => {
    expect(crumbsOf("/srv/footage")).toEqual([
      { name: "/", path: "/" },
      { name: "srv", path: "/srv" },
      { name: "footage", path: "/srv/footage" },
    ]);
    expect(crumbsOf("/")).toEqual([{ name: "/", path: "/" }]);
  });

  it("cuts a PC path below its drive", () => {
    expect(crumbsOf("C:\\Users\\x")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "x", path: "C:\\Users\\x" },
    ]);
    expect(crumbsOf("D:\\")).toEqual([{ name: "D:", path: "D:\\" }]);
  });

  it("keeps a network share as one top", () => {
    expect(crumbsOf("\\\\nas\\media\\cuts")).toEqual([
      { name: "\\\\nas\\media", path: "\\\\nas\\media\\" },
      { name: "cuts", path: "\\\\nas\\media\\cuts" },
    ]);
  });

  it("knows the parent and the leaf", () => {
    expect(parentOf("/srv/footage")).toBe("/srv");
    expect(parentOf("/")).toBeNull();
    expect(parentOf("C:\\Users")).toBe("C:\\");
    expect(leafName("/")).toBe("/");
    expect(leafName("C:\\")).toBe("C:\\");
    expect(leafName("/srv/footage")).toBe("footage");
  });
});

describe("crumbsBelow", () => {
  const root = { name: "Server storage", path: "/var/lib/vidai/media" };

  it("starts at the storage folder and names it as the picker does", () => {
    expect(crumbsBelow("/var/lib/vidai/media/ab/Trips", root)).toEqual([
      { name: "Server storage", path: "/var/lib/vidai/media" },
      { name: "ab", path: "/var/lib/vidai/media/ab" },
      { name: "Trips", path: "/var/lib/vidai/media/ab/Trips" },
    ]);
    expect(crumbsBelow("/var/lib/vidai/media", root)).toEqual([
      { name: "Server storage", path: "/var/lib/vidai/media" },
    ]);
  });

  it("shows every folder when there is no storage folder around the path", () => {
    expect(crumbsBelow("/srv/x", null)).toHaveLength(3);
    expect(crumbsBelow("/srv/x", root)).toHaveLength(3);
  });

  it("finds a PC storage folder whatever the case", () => {
    const share = { name: "shoots", path: "d:\\Shoots" };
    expect(crumbsBelow("D:\\shoots\\A", share).map((c) => c.name)).toEqual(["shoots", "A"]);
  });
});

describe("paths", () => {
  it("compares and nests paths", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/a/B", "/a/b")).toBe(false);
    expect(samePath("C:\\A\\", "c:\\a")).toBe(true);
    expect(isInsidePath("/srv", "/srv/footage/x")).toBe(true);
    expect(isInsidePath("/srv", "/srv2/x")).toBe(false);
  });
});

describe("typed paths", () => {
  it("accepts only a full path", () => {
    expect(isAbsolutePath("/srv")).toBe(true);
    expect(isAbsolutePath("C:\\Users")).toBe(true);
    expect(isAbsolutePath("c:/Users")).toBe(true);
    expect(isAbsolutePath("\\\\nas\\share")).toBe(true);
    expect(isAbsolutePath("Movies")).toBe(false);
    expect(isAbsolutePath("~/Movies")).toBe(false);
  });

  it("drops quotes and a closing separator, and writes a PC path with backslashes", () => {
    expect(normalizeTypedPath(' "/srv/x/" ')).toBe("/srv/x");
    expect(normalizeTypedPath("/")).toBe("/");
    expect(normalizeTypedPath("c:/Users/x/")).toBe("c:\\Users\\x");
    expect(normalizeTypedPath("C:\\")).toBe("C:\\");
    expect(normalizeTypedPath("\\\\nas/share/a")).toBe("\\\\nas\\share\\a");
  });
});
