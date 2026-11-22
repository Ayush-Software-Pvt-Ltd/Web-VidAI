/**
 * Which screen the page shows, and the path of every place (pure, tested in `route.test.ts`).
 * Wiring the paths to the History API belongs to the shell (Task 5); here are only the `Screen`
 * union, `decideScreen` and the two path helpers.
 *
 * Paths: `/` (main), `/setup`, `/timeline/<encoded video id>`, `/admin/<section>`,
 * `/settings/<section>` (`import-export` for the import and export section), `/archive`,
 * `/edit-log`, `/disk`.
 */
import type { ApiError } from "@/lib/errors";
import {
  ADMIN_SECTIONS,
  SETTINGS_SECTIONS,
  type AdminSection,
  type AppView,
  type Place,
  type Resource,
  type SettingsSection,
} from "@/lib/store";
import type { SessionInfo } from "@/lib/types";
import { decodeVideoId, encodeVideoId } from "@/lib/videoId";

export type Screen =
  | { kind: "loading" }
  | { kind: "fatal"; error: ApiError }
  | { kind: "signIn" }
  | { kind: "setup" }
  | { kind: AppView };

/** The screen for the session: loading, a fatal error, sign in, the first-admin setup, or a view. */
export function decideScreen(session: Resource<SessionInfo>, view: AppView): Screen {
  if (!session.data) {
    if (session.error && session.status !== "loading")
      return { kind: "fatal", error: session.error };
    return { kind: "loading" };
  }
  if (session.data.user === null) {
    return session.data.needsSetup ? { kind: "setup" } : { kind: "signIn" };
  }
  return { kind: view };
}

const SETTINGS_SLUGS: Record<SettingsSection, string> = {
  channels: "channels",
  appearance: "appearance",
  importExport: "import-export",
};

/** The path of a place (never ends with a slash, except `/`). */
export function pathOf(place: Place): string {
  switch (place.view) {
    case "main":
      return "/";
    case "settings":
      return `/settings/${SETTINGS_SLUGS[place.section]}`;
    case "admin":
      return `/admin/${place.section}`;
    case "archive":
      return "/archive";
    case "editLog":
      return "/edit-log";
    case "diskCleanup":
      return "/disk";
    case "timeline":
      return `/timeline/${encodeVideoId(place.videoId)}`;
  }
}

/** The place a path names (`null` for an unknown path). `/setup` is not a place: see `isSetupPath`. */
export function placeOf(pathname: string): Place | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/") return { view: "main" };
  if (path === "/archive") return { view: "archive" };
  if (path === "/edit-log") return { view: "editLog" };
  if (path === "/disk") return { view: "diskCleanup" };
  const [, head, rest, ...more] = path.split("/");
  if (rest === undefined || rest === "" || more.length > 0) return null;
  if (head === "timeline") {
    const videoId = decodeVideoId(rest);
    return videoId === null ? null : { view: "timeline", videoId };
  }
  if (head === "admin") {
    const section = ADMIN_SECTIONS.find((candidate) => candidate === rest);
    return section ? { view: "admin", section: section satisfies AdminSection } : null;
  }
  if (head === "settings") {
    const section = SETTINGS_SECTIONS.find((candidate) => SETTINGS_SLUGS[candidate] === rest);
    return section ? { view: "settings", section } : null;
  }
  return null;
}

/** `/setup` is the first-admin page (the setup address carries `?token=`). */
export function isSetupPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/setup";
}
