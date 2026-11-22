import { useCallback, useEffect } from "react";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import type { ApiOption, HarnessAdminState } from "@/lib/types";
import { selectionProblem } from "./model";

/**
 * The admin's harness state (`adminGetHarness`), loaded when the page opens; `null` while it is
 * not there yet. Every setter of the server answers the whole state, which `useHarnessCommit`
 * puts back (the server's events do not carry it).
 */
export function useHarnessState(): HarnessAdminState | null {
  const store = useAppStoreApi();
  const data = useAppState((s) => s.adminHarness.data);
  const status = useAppState((s) => s.adminHarness.status);
  useEffect(() => {
    if (status === "idle") void store.getState().loadAdminHarness();
  }, [status, store]);
  return data;
}

/** Awaits a harness setter and shows the state it answers; a refusal throws to the caller. */
export function useHarnessCommit(): (
  call: Promise<HarnessAdminState>,
) => Promise<HarnessAdminState> {
  const store = useAppStoreApi();
  return useCallback(
    async (call) => {
      const next = await call;
      store.getState().setAdminHarness(next);
      return next;
    },
    [store],
  );
}

/** What one API option has so far: its key, its model, and why it cannot run an edit yet. */
export interface ApiOptionView {
  /** Whether a key is saved; `null` while the state is not loaded. */
  keySaved: boolean | null;
  /** The last 4 characters of the saved key; `null` without a key or for a very short one. */
  keyLast4: string | null;
  /** The chosen model id, `null` when none is chosen. */
  model: string | null;
  /** The saved address, `null` is the default. */
  baseUrl: string | null;
  /** The reasoning effort kept per model id. */
  efforts: Record<string, string>;
  /** Why this option cannot be selected yet (the card's reason), `null` when it can. */
  problem: string | null;
  /** The harness state is loaded. */
  loaded: boolean;
}

export function useApiOption(option: ApiOption): ApiOptionView {
  const state = useAppState((s) => s.adminHarness.data?.options[option] ?? null);
  const keySaved = state?.key.saved ?? null;
  const model = state?.model ?? null;
  return {
    keySaved,
    keyLast4: state?.key.last4 ?? null,
    model,
    baseUrl: state?.baseUrl ?? null,
    efforts: state?.efforts ?? {},
    problem: state === null ? null : selectionProblem(option, keySaved, model),
    loaded: state !== null,
  };
}
