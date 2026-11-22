import { describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "./connection";

describe("connection store", () => {
  it("starts connecting, with no instance and no refusal", () => {
    expect(createConnectionStore().getSnapshot()).toEqual({
      status: "connecting",
      unauthorized: false,
      instance: null,
    });
  });

  it("takes an initial state", () => {
    const store = createConnectionStore({ status: "connected", instance: "mock" });
    expect(store.getSnapshot()).toEqual({
      status: "connected",
      unauthorized: false,
      instance: "mock",
    });
  });

  it("tells listeners about a change, with a new snapshot object", () => {
    const store = createConnectionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.update({ status: "connected" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().status).toBe("connected");
  });

  it("keeps the same snapshot and stays quiet when nothing differs", () => {
    const store = createConnectionStore({ status: "connected", instance: "a" });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.update({ status: "connected", instance: "a" });
    store.update({});
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
  });

  it("changes only the fields it is given", () => {
    const store = createConnectionStore({ instance: "a" });
    store.update({ status: "lost" });
    store.update({ unauthorized: true });
    expect(store.getSnapshot()).toEqual({ status: "lost", unauthorized: true, instance: "a" });
  });

  it("stops telling a listener that unsubscribed", () => {
    const store = createConnectionStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.update({ status: "lost" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("lets a listener unsubscribe itself while being told", () => {
    const store = createConnectionStore();
    const second = vi.fn();
    const off = store.subscribe(() => {
      off();
    });
    store.subscribe(second);
    store.update({ status: "lost" });
    store.update({ status: "connected" });
    expect(second).toHaveBeenCalledTimes(2);
  });
});
