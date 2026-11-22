/**
 * A shared clock: every subscriber of the same interval re-renders from one timer, so hundreds
 * of rows never create hundreds of intervals. Subscribing with `enabled = false` costs nothing.
 */
import { useCallback, useSyncExternalStore } from "react";

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set(), timer: null };
    tickers.set(intervalMs, ticker);
  }
  return ticker;
}

function subscribe(intervalMs: number, listener: () => void): () => void {
  const ticker = tickerFor(intervalMs);
  ticker.listeners.add(listener);
  if (!ticker.timer) {
    ticker.now = Date.now();
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const l of ticker.listeners) l();
    }, intervalMs);
  }
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0 && ticker.timer) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
}

const noop = () => () => {};

/**
 * The current time in ms, updated every `intervalMs` while `enabled`. When disabled the value is
 * the last tick and does not update, so only read it while enabled.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const subscribeTo = useCallback(
    (listener: () => void) => subscribe(intervalMs, listener),
    [intervalMs],
  );
  return useSyncExternalStore(enabled ? subscribeTo : noop, () => tickerFor(intervalMs).now);
}
