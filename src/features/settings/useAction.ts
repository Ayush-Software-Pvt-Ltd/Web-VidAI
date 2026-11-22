import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, toApiError } from "@/lib/errors";

export interface Action<A extends unknown[]> {
  /** Runs the action; resolves to `true` when it succeeded. Never rejects. */
  run: (...args: A) => Promise<boolean>;
  pending: boolean;
  /** The error of the last run, cleared when the next run starts. */
  error: ApiError | null;
  clearError: () => void;
}

/**
 * Wraps an async command for a button: a pending flag for its spinner and the last error for an
 * inline message. State updates after unmount are skipped.
 */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): Action<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A) => {
    setPending(true);
    setError(null);
    try {
      await fnRef.current(...args);
      return true;
    } catch (e) {
      if (mounted.current) setError(toApiError(e));
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { run, pending, error, clearError };
}
