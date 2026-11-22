import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPlatform,
  hasShortcutModifier,
  holdsModifier,
  isPlatform,
  isShortcut,
  platformInfo,
} from "./platform";

const key = (init: Partial<KeyboardEvent>) => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe("platformInfo", () => {
  it("shows keys the Mac way", () => {
    const mac = platformInfo("macos");
    expect(mac.platform).toBe("macos");
    expect(mac.shortcut(["mod", "C"])).toBe("⌘C");
    expect(mac.keyLabel("mod")).toBe("⌘");
    expect(mac.keyLabel("enter")).toBe("↩");
    expect(mac.keyLabel("esc")).toBe("esc");
    expect(mac.keyLabel("F")).toBe("F");
    expect(mac.ariaShortcut("F")).toBe("Meta+F");
  });

  it("shows keys the PC way", () => {
    const pc = platformInfo("windows");
    expect(pc.platform).toBe("windows");
    expect(pc.shortcut(["mod", "C"])).toBe("Ctrl+C");
    expect(pc.keyLabel("mod")).toBe("Ctrl");
    expect(pc.keyLabel("enter")).toBe("Enter");
    expect(pc.keyLabel("esc")).toBe("Esc");
    expect(pc.ariaShortcut("F")).toBe("Control+F");
  });

  it("offers only the key conventions", () => {
    expect(Object.keys(platformInfo("macos")).sort()).toEqual([
      "ariaShortcut",
      "keyLabel",
      "offersShortcut",
      "platform",
      "shortcut",
    ]);
  });

  it("does not advertise the keys a browser keeps for itself", () => {
    const mac = platformInfo("macos");
    const pc = platformInfo("windows");
    for (const keys of [
      ["mod", "+"],
      ["mod", "="],
      ["mod", "−"],
      ["mod", "-"],
      ["mod", "0"],
    ]) {
      expect(mac.offersShortcut(keys)).toBe(false);
      expect(pc.offersShortcut(keys)).toBe(false);
    }
    // Cmd+, is the browser's settings on a Mac; Ctrl+, is free on a PC.
    expect(mac.offersShortcut(["mod", ","])).toBe(false);
    expect(pc.offersShortcut(["mod", ","])).toBe(true);
    for (const keys of [["mod", "F"], ["mod", "S"], ["mod", "enter"], ["esc"], ["mod"]]) {
      expect(mac.offersShortcut(keys)).toBe(true);
      expect(pc.offersShortcut(keys)).toBe(true);
    }
  });
});

describe("shortcut modifier", () => {
  it("is Cmd (or Ctrl) on macOS", () => {
    expect(isShortcut(key({ key: ",", metaKey: true }), "macos", ",")).toBe(true);
    expect(isShortcut(key({ key: ",", ctrlKey: true }), "macos", ",")).toBe(true);
    expect(isShortcut(key({ key: "F", metaKey: true }), "macos", "f")).toBe(true);
    expect(isShortcut(key({ key: ",", metaKey: true, shiftKey: true }), "macos", ",")).toBe(false);
    expect(isShortcut(key({ key: ",", metaKey: true, altKey: true }), "macos", ",")).toBe(false);
    expect(isShortcut(key({ key: "," }), "macos", ",")).toBe(false);
  });

  it("is Ctrl on Windows, never the Windows key", () => {
    expect(isShortcut(key({ key: ",", ctrlKey: true }), "windows", ",")).toBe(true);
    expect(isShortcut(key({ key: "Enter", ctrlKey: true }), "windows", "Enter")).toBe(true);
    expect(isShortcut(key({ key: ",", metaKey: true }), "windows", ",")).toBe(false);
    expect(isShortcut(key({ key: ",", metaKey: true, ctrlKey: true }), "windows", ",")).toBe(false);
    // Ctrl+Alt is AltGr on many Windows keyboards: never a shortcut.
    expect(isShortcut(key({ key: "s", ctrlKey: true, altKey: true }), "windows", "s")).toBe(false);
    expect(hasShortcutModifier(key({ ctrlKey: true, shiftKey: true }), "windows")).toBe(false);
    expect(
      hasShortcutModifier(key({ ctrlKey: true, shiftKey: true }), "windows", { shift: true }),
    ).toBe(true);
  });

  it("holds the modifier whatever Shift and Alt do", () => {
    expect(holdsModifier(key({ metaKey: true }), "macos")).toBe(true);
    expect(holdsModifier(key({ ctrlKey: true }), "windows")).toBe(true);
    expect(holdsModifier(key({}), "windows")).toBe(false);
  });
});

describe("detectPlatform", () => {
  afterEach(() => vi.restoreAllMocks());

  const withAgent = (userAgent: string) =>
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);

  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "macos"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "macos"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0", "windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0", "windows"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/130.0", "windows"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile", "macos"],
  ] as const)("reads %s as %s conventions", (agent, platform) => {
    withAgent(agent);
    expect(detectPlatform()).toBe(platform);
  });

  it("validates platform names", () => {
    expect(isPlatform("macos")).toBe(true);
    expect(isPlatform("windows")).toBe(true);
    expect(isPlatform("linux")).toBe(false);
    expect(isPlatform(null)).toBe(false);
  });
});
