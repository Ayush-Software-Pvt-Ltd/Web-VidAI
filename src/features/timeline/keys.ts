/**
 * Who gets a key on the timeline screen. One listener at the document (`screen/useShortcuts.ts`)
 * owns every key; the parts of the screen that need one claim it here and the listener asks them,
 * so two parts never act on the same key press.
 *
 * - `c` (ask for a change): the change request panel claims it.
 * - `Escape`: claimed by whatever can be cancelled, the highest priority first, and the first claim
 *   that answers `true` used the key: a drag of a clip (priority 2) before a request being drawn
 *   (priority 1). One press cancels one thing.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";

export type ClaimedKey = "c" | "Escape";

/** Answers `true` when it used the key press (the key is then not used for anything else). */
export type KeyClaim = () => boolean;

export const PRIORITY = { drag: 2, request: 1 } as const;

export interface KeyRegistry {
  claim: (key: ClaimedKey, handler: KeyClaim, priority?: number) => () => void;
  /** Asks the claims of `key`, highest priority first; `true` when one used it. */
  run: (key: ClaimedKey) => boolean;
}

export function createKeyRegistry(): KeyRegistry {
  const claims = new Map<ClaimedKey, Array<{ handler: KeyClaim; priority: number }>>();
  return {
    claim(key, handler, priority = 0) {
      const entry = { handler, priority };
      const list = [...(claims.get(key) ?? []), entry].sort((a, b) => b.priority - a.priority);
      claims.set(key, list);
      return () => {
        claims.set(
          key,
          (claims.get(key) ?? []).filter((other) => other !== entry),
        );
      };
    },
    run(key) {
      for (const { handler } of [...(claims.get(key) ?? [])]) if (handler()) return true;
      return false;
    },
  };
}

export const KeyRegistryContext = createContext<KeyRegistry | null>(null);

/** Claims `key` for as long as the component lives; `handler` may change between renders. */
export function useKeyClaim(key: ClaimedKey, handler: KeyClaim, priority?: number): void {
  const registry = useContext(KeyRegistryContext);
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!registry) return;
    return registry.claim(key, () => latest.current(), priority);
  }, [registry, key, priority]);
}
