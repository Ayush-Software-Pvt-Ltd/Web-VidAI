/**
 * What the page knows about the operating system of the browser, in one place: the modifier key of
 * shortcuts, how keys are shown ("⌘" or "Ctrl"), and which shortcuts the browser keeps for itself
 * and so must not be advertised. VidAI is a web app: the server's own computer and programs are
 * never named here (the server words those). Components never test the platform themselves; they
 * ask `usePlatform()` (or `platformInfo(platform)` outside React) for the trait they need.
 *
 * The platform comes from the browser (`detectPlatform`, from its user agent); tests pass it in.
 */
import type { Platform } from "./types";

export type { Platform };

const PLATFORMS: readonly Platform[] = ["macos", "windows"];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * The operating system of this browser: Windows when the user agent says so, otherwise the
 * macOS conventions (Cmd, "↩"), which also serve Linux and the like as far as the page is
 * concerned only in the key labels (Linux browsers use Ctrl: see `isLinuxLike`).
 */
export function detectPlatform(): Platform {
  if (typeof window === "undefined") return "macos";
  const agent = window.navigator.userAgent;
  if (/\bWindows\b/.test(agent) || isLinuxLike(agent)) return "windows";
  return "macos";
}

/** Linux, ChromeOS and the like use Ctrl for shortcuts exactly like Windows does. */
function isLinuxLike(agent: string): boolean {
  return /\b(Linux|CrOS|X11)\b/.test(agent) && !/\b(Android|Macintosh|iPhone|iPad)\b/.test(agent);
}

/** Keys of a shortcut hint: a key cap's text, or one of these tokens shown per platform. */
export type KeyToken = "mod" | "enter" | "esc";

type KeyName = KeyToken | (string & {});

export interface PlatformInfo {
  /** The shortcut conventions in force: `macos` (Cmd) or `windows` (Ctrl, also on Linux). */
  platform: Platform;
  /** Shown text of a key token or key. */
  keyLabel: (key: KeyName) => string;
  /** A shortcut as one string for running text, for example "⌘C" or "Ctrl+C". */
  shortcut: (keys: readonly KeyName[]) => string;
  /** The `aria-keyshortcuts` value of the modifier plus `key`, for example "Meta+F". */
  ariaShortcut: (key: string) => string;
  /**
   * Whether a shortcut can be shown as a hint: not the keys the browser keeps for itself
   * (`browserKeepsShortcut`). Every hint goes through this, so the page never advertises a key
   * it will not get.
   */
  offersShortcut: (keys: readonly KeyName[]) => boolean;
}

const MAC_KEYS: Record<KeyToken, string> = { mod: "⌘", enter: "↩", esc: "esc" };
const PC_KEYS: Record<KeyToken, string> = { mod: "Ctrl", enter: "Enter", esc: "Esc" };

function isToken(key: string): key is KeyToken {
  return key === "mod" || key === "enter" || key === "esc";
}

/**
 * Shortcuts a browser does not hand to the page: its own zoom keys (the modifier with `+`, `=`,
 * `-`, `0`) and, on a Mac, Cmd+`,` (the browser's settings).
 */
function browserKeepsShortcut(keys: readonly KeyName[], platform: Platform): boolean {
  const [first, key, ...more] = keys;
  if (first !== "mod" || key === undefined || more.length > 0) return false;
  if (["+", "=", "-", "−", "0"].includes(key)) return true;
  return platform === "macos" && key === ",";
}

/** The shortcut conventions of `platform`. */
export function platformInfo(platform: Platform): PlatformInfo {
  const mac = platform === "macos";
  const keys = mac ? MAC_KEYS : PC_KEYS;
  const show = (key: KeyName) => (isToken(key) ? keys[key] : key);
  return {
    platform,
    keyLabel: show,
    shortcut: (list) => list.map(show).join(mac ? "" : "+"),
    ariaShortcut: (key) => `${mac ? "Meta" : "Control"}+${key}`,
    offersShortcut: (list) => !browserKeepsShortcut(list, platform),
  };
}

/**
 * Whether the shortcut modifier is held, whatever Shift and Alt do: Cmd on macOS (or Ctrl, as it
 * always was), Ctrl without the Windows key on Windows and Linux.
 */
export function holdsModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  platform: Platform,
): boolean {
  return platform === "windows" ? event.ctrlKey && !event.metaKey : event.metaKey || event.ctrlKey;
}

/**
 * Whether a key press holds the shortcut modifier and nothing else (Shift only when `shift`).
 */
export function hasShortcutModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: Platform,
  { shift = false }: { shift?: boolean } = {},
): boolean {
  if (event.altKey || event.shiftKey !== shift) return false;
  return holdsModifier(event, platform);
}

/**
 * Whether a key press is the shortcut modifier plus `key` (compared without letter case), for
 * example `isShortcut(event, platform, "f")` for Cmd+F / Ctrl+F.
 */
export function isShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: Platform,
  key: string,
): boolean {
  return hasShortcutModifier(event, platform) && event.key.toLowerCase() === key.toLowerCase();
}
