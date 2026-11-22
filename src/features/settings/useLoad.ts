import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, toApiError } from "@/lib/errors";

export interface Load<T> {
  data: T | null;
  /** True until the first result arrives and while reloading. */
  loading: boolean;
  error: ApiError | null;
  reload: () => Promise<void>;
  /** Replaces the data, for example with the result of a command. */
  set: (data: T) => void;
}

/**
 * Loads one backend resource that is not in the app store (for example the toolkit status) when
 * the component mounts. A newer load or `set` wins over a slower older load.
 */
export function useLoad<T>(fetch: () => Promise<T>): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const fetchRef = useRef(fetch);
  // Incremented by every load and `set`, and on unmount; a load only applies its own result.
  const generation = useRef(0);
  useEffect(() => {
    fetchRef.current = fetch;
  });

  const start = useCallback((): Promise<void> => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    return fetchRef.current().then(
      (result) => {
        if (!current()) return;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!current()) return;
        setError(toApiError(e));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    void start();
    const counter = generation;
    return () => {
      counter.current++;
    };
  }, [start]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    return start();
  }, [start]);

  const set = useCallback((next: T) => {
    generation.current++;
    setData(next);
    setLoading(false);
    setError(null);
  }, []);

  return { data, loading, error, reload, set };
}
