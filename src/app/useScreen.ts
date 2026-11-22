import { useMemo } from "react";
import { useAppState } from "@/lib/appEnv";
import { decideScreen, type Screen } from "./route";

/** The screen the page shows now: `decideScreen` on the session and the place in the store. */
export function useScreen(): Screen {
  const session = useAppState((s) => s.session);
  const view = useAppState((s) => s.view);
  // `decideScreen` builds a new object, so it must not run inside a selector.
  return useMemo(() => decideScreen(session, view), [session, view]);
}
