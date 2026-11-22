import { useCallback, useSyncExternalStore } from "react";
import { useApi } from "@/lib/appEnv";
import type { ConnectionState } from "@/lib/connection";

/** The state of the link to the server (`api.connection`). */
export function useConnection(): ConnectionState {
  const { connection } = useApi();
  const subscribe = useCallback(
    (listener: () => void) => connection.subscribe(listener),
    [connection],
  );
  const snapshot = useCallback(() => connection.getSnapshot(), [connection]);
  return useSyncExternalStore(subscribe, snapshot);
}
