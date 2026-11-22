/**
 * A small typed event bus that implements `ApiEvents`: both backends use it (the HTTP backend
 * emits what the event stream delivers, the mock emits what its areas publish).
 */
import type { ApiEvents } from "./api";
import { EVENT_NAMES, eventMethodName, type EventName, type EventPayloads } from "./rpc";

export interface EventHub {
  on: ApiEvents;
  emit: <E extends EventName>(event: E, payload: EventPayloads[E]) => void;
  /** Drops every subscriber. */
  clear: () => void;
}

export function createEventHub(): EventHub {
  const handlers = new Map<EventName, Set<(payload: never) => void>>();
  const on: Record<string, (handler: (payload: never) => void) => () => void> = {};
  for (const name of EVENT_NAMES) {
    on[eventMethodName(name)] = (handler) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    };
  }
  return {
    on: on as unknown as ApiEvents,
    emit(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload as never);
    },
    clear: () => handlers.clear(),
  };
}
