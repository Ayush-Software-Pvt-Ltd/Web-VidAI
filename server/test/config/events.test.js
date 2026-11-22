import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createEventBus } from "../../src/events.js";

/** @typedef {import("../../src/events.js").BusEvent} BusEvent */

/**
 * @param {ReturnType<typeof createEventBus>} bus
 * @param {string} userId
 * @param {"admin" | "user"} role
 */
function listen(bus, userId, role) {
  /** @type {string[]} */
  const got = [];
  const off = bus.subscribe({ userId, role }, (e) => {
    got.push(e.event);
  });
  return { got, off };
}

describe("event bus", () => {
  test("an event with a userId reaches that user only", () => {
    const bus = createEventBus();
    const a = listen(bus, "a", "user");
    const b = listen(bus, "b", "user");
    bus.emit({ event: "x", payload: 1, userId: "a", admins: false });
    assert.deepEqual(a.got, ["x"]);
    assert.deepEqual(b.got, []);
  });

  test("userId null reaches everybody", () => {
    const bus = createEventBus();
    const a = listen(bus, "a", "user");
    const admin = listen(bus, "z", "admin");
    bus.emit({ event: "x", payload: null, userId: null, admins: false });
    assert.deepEqual([a.got, admin.got], [["x"], ["x"]]);
  });

  test("admins: true adds admins, whoever the owner is, and no ordinary user", () => {
    const bus = createEventBus();
    const owner = listen(bus, "a", "user");
    const other = listen(bus, "b", "user");
    const admin = listen(bus, "z", "admin");
    bus.emit({ event: "x", payload: null, userId: "a", admins: true });
    assert.deepEqual([owner.got, other.got, admin.got], [["x"], [], ["x"]]);
    bus.emit({ event: "y", payload: null, userId: "a", admins: false });
    assert.deepEqual(admin.got, ["x"]);
  });

  test("the listener gets the whole event", () => {
    const bus = createEventBus();
    /** @type {BusEvent[]} */
    const got = [];
    bus.subscribe({ userId: "a", role: "user" }, (e) => got.push(e));
    const event = { event: "job-updated", payload: { id: 1 }, userId: "a", admins: true };
    bus.emit(event);
    assert.deepEqual(got, [event]);
  });

  test("unsubscribe stops delivery and is safe twice", () => {
    const bus = createEventBus();
    const a = listen(bus, "a", "user");
    a.off();
    a.off();
    bus.emit({ event: "x", payload: null, userId: null, admins: false });
    assert.deepEqual(a.got, []);
  });

  test("a failing listener does not stop the others and is reported", () => {
    /** @type {unknown[]} */
    const errors = [];
    const bus = createEventBus({ onError: (e) => errors.push(e) });
    bus.subscribe({ userId: "a", role: "user" }, () => {
      throw new Error("bad listener");
    });
    const b = listen(bus, "a", "user");
    bus.emit({ event: "x", payload: null, userId: null, admins: false });
    assert.deepEqual(b.got, ["x"]);
    assert.equal(errors.length, 1);
  });

  test("a listener may unsubscribe itself while an event is delivered", () => {
    const bus = createEventBus();
    /** @type {() => void} */
    let off = () => {};
    let calls = 0;
    off = bus.subscribe({ userId: "a", role: "user" }, () => {
      calls++;
      off();
    });
    const other = listen(bus, "a", "user");
    bus.emit({ event: "x", payload: null, userId: null, admins: false });
    bus.emit({ event: "y", payload: null, userId: null, admins: false });
    assert.equal(calls, 1);
    assert.deepEqual(other.got, ["x", "y"]);
  });

  test("closeUser tells that user's subscribers session-ended and calls onClose", () => {
    const bus = createEventBus();
    /** @type {BusEvent[]} */
    const got = [];
    let closed = 0;
    bus.subscribe(
      { userId: "a", role: "user" },
      (e) => got.push(e),
      () => closed++,
    );
    bus.subscribe(
      { userId: "a", role: "admin" },
      () => {},
      () => closed++,
    );
    const b = listen(bus, "b", "user");
    bus.closeUser("a");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.event, "session-ended");
    assert.equal(got[0]?.userId, "a");
    assert.equal(closed, 2);
    assert.deepEqual(b.got, []);
    // They are gone: nothing more arrives.
    bus.emit({ event: "x", payload: null, userId: null, admins: false });
    assert.equal(got.length, 1);
    bus.closeUser("a");
    assert.equal(closed, 2);
  });
});
