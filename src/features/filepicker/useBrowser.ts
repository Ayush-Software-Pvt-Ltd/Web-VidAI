/**
 * Where the dialog is and what it shows: the listing of one folder, the places, the selection.
 * Navigation is asynchronous and answers can arrive in any order, so only the answer to the last
 * navigation counts (an earlier, slower one is dropped).
 *
 * The picker is the admin's and browses the server's whole file system (SPEC section 6, "Folders
 * on the server"), so there is no folder it may not leave: the top is the top of a drive.
 *
 * What a failed listing does depends on why the server refused:
 * - the folder is gone or cannot be read (`invalidInput`, `notFound`, for example an unplugged
 *   drive): the nearest folder above that still exists is shown, with a remark that says so;
 * - the server does not allow it (`forbidden`, `conflict`): the folder that was shown stays, with
 *   the server's sentence as a remark;
 * - anything else (`io`, a lost connection) is the error state, which offers Try Again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import type { FsListing, FsPlace } from "@/lib/types";
import {
  crumbsBelow,
  isAbsolutePath,
  isInsidePath,
  leafName,
  parentOf,
  samePath,
} from "./pathText";

export interface GoOptions {
  /** When `path` cannot be shown at all, show the home folder instead (the first listing). */
  fallbackHome?: boolean;
}

export interface Notice {
  text: string;
  /** `error` for a refusal, `info` for "showing another folder instead". */
  tone: "error" | "info";
}

export interface Browser {
  /** The folder being shown or opened (the asked path while it loads or when it cannot be read). */
  location: string | null;
  /** The answer for `location`, `null` while there is none yet or after an error. */
  listing: FsListing | null;
  /** The server's message for a folder that cannot be read. */
  error: string | null;
  loading: boolean;
  places: FsPlace[];
  /** The path of the selected entry. */
  selected: string | null;
  select: (path: string | null) => void;
  /** A remark about the last navigation, `null` when there is none. */
  notice: Notice | null;
  say: (notice: Notice | null) => void;
  /** Opens `path` (`null` is the home folder); resolves with the listing, or `null` if it failed or was replaced. */
  go: (path: string | null, options?: GoOptions) => Promise<FsListing | null>;
  /** The place (home, drive or volume) `path` lies in, the innermost one. */
  placeOf: (path: string) => FsPlace | null;
  /** The drive or volume `path` lies on: the breadcrumbs start there. */
  driveOf: (path: string) => FsPlace | null;
  /** Whether a folder seen in a listing cannot become a channel (it is `taken`). */
  isTaken: (path: string) => boolean;
  /** The folder above, `null` at the top of a drive. */
  upTarget: string | null;
}

export function useBrowser(api: Pick<Api, "fsPlaces" | "fsList">): Browser {
  const [location, setLocation] = useState<string | null>(null);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [places, setPlaces] = useState<FsPlace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const latest = useRef(0);
  const shown = useRef<FsListing | null>(null);
  const placesRef = useRef<FsPlace[]>([]);

  useEffect(() => {
    let current = true;
    api.fsPlaces().then(
      (found) => {
        if (!current) return;
        placesRef.current = found;
        setPlaces(found);
      },
      () => {
        // Without places the dialog still browses.
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  const innermost = useCallback((path: string, wanted: (place: FsPlace) => boolean) => {
    let best: FsPlace | null = null;
    for (const place of placesRef.current) {
      if (!wanted(place) || !isInsidePath(place.path, path)) continue;
      if (best === null || place.path.length > best.path.length) best = place;
    }
    return best;
  }, []);

  const placeOf = useCallback((path: string) => innermost(path, () => true), [innermost]);
  const driveOf = useCallback(
    (path: string) => innermost(path, (place) => place.kind !== "home"),
    [innermost],
  );

  /** What the listings seen so far said about each folder: `taken` or not. */
  const takenRef = useRef(new Map<string, boolean>());
  const isTaken = useCallback((path: string) => takenRef.current.get(path) === true, []);

  /** How the picker calls a folder: a place by its name, any other by its last part. */
  const nameOf = useCallback(
    (path: string): string => {
      const found = placeOf(path);
      return found !== null && samePath(found.path, path) ? found.name : leafName(path);
    },
    [placeOf],
  );

  const go = useCallback(
    async (path: string | null, { fallbackHome = false }: GoOptions = {}) => {
      const mine = ++latest.current;
      setLoading(true);
      setNotice(null);
      setSelected(null);
      if (path !== null) setLocation(path);
      let target = path;
      let gone: string | null = null;
      let refusal: string | null = null;
      let triedHome = path === null;
      for (;;) {
        try {
          const answer = await api.fsList(target === null ? undefined : { path: target });
          if (mine !== latest.current) return null;
          shown.current = answer;
          for (const entry of answer.entries) takenRef.current.set(entry.path, entry.taken);
          setLocation(answer.path);
          setListing(answer);
          setError(null);
          if (refusal !== null) {
            setNotice({
              text: `${refusal} Showing "${nameOf(answer.path)}" instead.`,
              tone: "info",
            });
          } else if (gone !== null) {
            setNotice({
              text: `"${nameOf(gone)}" does not exist any more. Showing "${nameOf(answer.path)}" instead.`,
              tone: "info",
            });
          }
          setLoading(false);
          return answer;
        } catch (failure) {
          if (mine !== latest.current) return null;
          const problem = toApiError(failure);
          const missing = problem.code === "invalidInput" || problem.code === "notFound";
          if (missing && target !== null && isAbsolutePath(target)) {
            const up = parentOf(target);
            if (up !== null) {
              gone = target;
              target = up;
              continue;
            }
          }
          if (fallbackHome && !triedHome) {
            triedHome = true;
            refusal = problem.message;
            target = null;
            continue;
          }
          const kept = shown.current;
          if ((problem.code === "forbidden" || problem.code === "conflict") && kept !== null) {
            setLocation(kept.path);
            setListing(kept);
            setError(null);
            setNotice({ text: problem.message, tone: "error" });
          } else {
            shown.current = null;
            setListing(null);
            setError(problem.message);
          }
          setLoading(false);
          return null;
        }
      }
    },
    [api, nameOf],
  );

  const shownHere = listing !== null && listing.path === location;
  let upTarget: string | null = null;
  if (location !== null) {
    if (shownHere) upTarget = listing.parent;
    else {
      const crumbs = crumbsBelow(location, rootCrumb(driveOf(location)));
      upTarget = crumbs.length > 1 ? (crumbs.at(-2)?.path ?? null) : null;
    }
  }

  return {
    location,
    listing,
    error,
    loading,
    places,
    selected,
    select: setSelected,
    notice,
    say: setNotice,
    go,
    placeOf,
    driveOf,
    isTaken,
    upTarget,
  };
}

/** The first breadcrumb of a drive or volume. */
export function rootCrumb(place: FsPlace | null): { name: string; path: string } | null {
  return place === null ? null : { name: place.name, path: place.path };
}
