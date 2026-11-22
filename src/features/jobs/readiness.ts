import { useAppState, useIsAdmin } from "@/lib/appEnv";
import { problemFix, problemMessage, problemTitle } from "@/lib/readiness";

/** What blocks new edits right now, as the server says it (`getReadiness`), for Start Editing. */
export interface StartBlock {
  title: string;
  /** The server's sentence, worded for this audience. */
  message: string;
  /** Where an admin fixes it: the harness settings or the System page of Admin. */
  fix: "settings" | "system";
  /** The viewer may open Admin; everyone else asks an admin. */
  admin: boolean;
}

/** The reason new edits cannot start, or `null` (also while the server has not answered yet). */
export function useStartBlock(): StartBlock | null {
  const readiness = useAppState((s) => s.readiness.data);
  const admin = useIsAdmin();
  const problem = readiness?.problem ?? null;
  const title = problemTitle(readiness);
  const message = problemMessage(readiness);
  if (problem === null || title === null || message === null) return null;
  return { title, message, fix: problemFix(problem), admin };
}
