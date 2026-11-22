// The event stream: the decoder (ported from `sse_frames_in_any_pieces` of `child.rs`) and the
// reader, which the desktop app did not have to test because it never reconnected.

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  MAX_EVENT_BYTES,
  SseDecoder,
  createEventStream,
} from "../../src/agents/opencode/serverStream.js";
import { sleep, until } from "./engineSupport.js";

test("sse frames in any pieces", () => {
  const stream = Buffer.from(
    'data: {"a":1}\n\n: comment\r\nevent: message\r\nid: 7\r\ndata: {"b":\r\ndata: 2}\r\n\r\ndata:x\n\n',
  );
  const whole = new SseDecoder();
  const all = whole.push(stream);
  assert.deepEqual(all, ['{"a":1}', '{"b":\n2}', "x"]);
  assert.equal(whole.lastEventId, "7");
  for (const size of [1, 2, 3, 7, 50]) {
    const pieces = new SseDecoder();
    const got = [];
    for (let at = 0; at < stream.length; at += size) {
      got.push(...pieces.push(stream.subarray(at, at + size)));
    }
    assert.deepEqual(got, all, `pieces of ${size}`);
  }
  // An event without data and an unfinished one give nothing.
  assert.deepEqual(new SseDecoder().push(Buffer.from("event: x\n\ndata: half")), []);
});

test("a multi-byte character cut by a chunk edge stays whole", () => {
  const bytes = Buffer.from("data: वीडियो\n\n");
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 9)), []);
  assert.deepEqual(decoder.push(bytes.subarray(9)), ["वीडियो"]);
});

test("an event over the limit is dropped whole and the next one still arrives", () => {
  const decoder = new SseDecoder();
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  /** @type {string[]} */
  const got = [];
  got.push(...decoder.push(Buffer.from("data: ")));
  for (let i = 0; i <= MAX_EVENT_BYTES / chunk.length; i += 1) got.push(...decoder.push(chunk));
  got.push(...decoder.push(Buffer.from("\n\ndata: next\n\n")));
  assert.deepEqual(got, ["next"]);
});

/**
 * A server of server-sent events whose connections the test controls.
 * @param {import("node:test").TestContext} t
 * @param {(request: http.IncomingMessage, response: http.ServerResponse, n: number) => void} onConnection
 */
async function eventServer(t, onConnection) {
  /** @type {Array<{ headers: http.IncomingHttpHeaders, response: http.ServerResponse }>} */
  const connections = [];
  const server = http.createServer((request, response) => {
    connections.push({ headers: request.headers, response });
    onConnection(request, response, connections.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${address.port}/api/event`, connections };
}

/** @param {http.ServerResponse} response */
function open(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
}

/**
 * @param {string} url
 * @param {Partial<import("../../src/agents/opencode/serverStream.js").StreamOptions>} options
 */
function stream(url, options) {
  /** @type {string[]} */
  const data = [];
  const events = createEventStream({
    url,
    headers: { authorization: "Basic x" },
    fetch,
    firstEventTimeoutMs: 2_000,
    reconnectGapsMs: [10, 20],
    serverAlive: () => true,
    onData: (text) => data.push(text),
    ...options,
  });
  return { events, data };
}

test("the stream connects at the first event, and gives every event's data in order", async (t) => {
  const server = await eventServer(t, (_request, response) => {
    open(response);
    response.write('id: 1\ndata: {"id":"1"}\n\n');
    response.write(": heartbeat\n\n");
    response.write('id: 2\ndata: {"id":"2"}\n\n');
  });
  const { events, data } = stream(server.url, {});
  await events.connected;
  await until("both events", () => data.length === 2 || undefined);
  assert.deepEqual(data, ['{"id":"1"}', '{"id":"2"}']);
  assert.equal(server.connections[0]?.headers["authorization"], "Basic x");
  assert.equal(server.connections[0]?.headers["accept"], "text/event-stream");
  events.stop();
  await events.done;
});

test("a refused first connection fails once, in OpenCode's words, with no retry", async (t) => {
  const server = await eventServer(t, (_request, response) => {
    response.writeHead(401).end();
  });
  const { events } = stream(server.url, {});
  await assert.rejects(events.connected, /OpenCode refused the event stream \(HTTP 401\)/);
  await events.done;
  await sleep(60);
  assert.equal(server.connections.length, 1);
});

test("nothing listening is told as the server being unreachable", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (closed.address());
  await new Promise((resolve) => closed.close(() => resolve(undefined)));
  const { events } = stream(`http://127.0.0.1:${address.port}/api/event`, {});
  await assert.rejects(
    events.connected,
    /Could not reach the OpenCode server on the computer that runs VidAI/,
  );
  await events.done;
});

test("a stream that sends no first event within the limit did not connect", async (t) => {
  const server = await eventServer(t, (_request, response) => open(response));
  const { events } = stream(server.url, { firstEventTimeoutMs: 80 });
  await assert.rejects(events.connected, /OpenCode's event stream did not connect/);
  await events.done;
  assert.equal(server.connections.length, 1);
});

test("a dropped stream is connected again, with the id of the last event", async (t) => {
  const server = await eventServer(t, (_request, response, n) => {
    open(response);
    if (n === 1) {
      response.write('id: 5\ndata: {"id":"5"}\n\n');
      setTimeout(() => response.destroy(), 20);
    } else {
      response.write('id: 6\ndata: {"id":"6"}\n\n');
    }
  });
  const { events, data } = stream(server.url, {});
  await events.connected;
  await until("the event after the reconnect", () => data.length === 2 || undefined);
  assert.deepEqual(data, ['{"id":"5"}', '{"id":"6"}']);
  assert.equal(server.connections[1]?.headers["last-event-id"], "5");
  assert.equal(events.reconnects(), 1);
  events.stop();
  await events.done;
});

test("the reconnect gaps grow and the last one repeats; a good connection resets them", async (t) => {
  const starts = /** @type {number[]} */ ([]);
  const server = await eventServer(t, (_request, response, n) => {
    starts.push(Date.now());
    if (n === 1) {
      open(response);
      response.write('data: {"id":"a"}\n\n');
      setTimeout(() => response.destroy(), 5);
    } else if (n < 6) {
      response.destroy();
    } else {
      open(response);
      response.write('data: {"id":"b"}\n\n');
    }
  });
  const { events, data } = stream(server.url, { reconnectGapsMs: [30, 60] });
  await events.connected;
  await until("the last connection", () => data.length === 2 || undefined);
  const gaps = starts.slice(1).map((at, i) => at - (starts[i] ?? at));
  // 30, 60, 60, 60 (the last repeats), with some slack for timers.
  assert.ok((gaps[1] ?? 0) >= 25, `${gaps}`);
  assert.ok((gaps[2] ?? 0) >= 55, `${gaps}`);
  assert.ok((gaps[3] ?? 0) >= 55, `${gaps}`);
  events.stop();
  await events.done;
});

test("there is no reconnect once the server is gone", async (t) => {
  let alive = true;
  const server = await eventServer(t, (_request, response) => {
    open(response);
    response.write('data: {"id":"a"}\n\n');
    setTimeout(() => {
      alive = false;
      response.end();
    }, 20);
  });
  const { events, data } = stream(server.url, { serverAlive: () => alive });
  await events.connected;
  await events.done;
  assert.deepEqual(data, ['{"id":"a"}']);
  await sleep(60);
  assert.equal(server.connections.length, 1);
});

test("stopping ends the reader at once, also while it waits for the next reconnect", async (t) => {
  const server = await eventServer(t, (_request, response, n) => {
    if (n === 1) {
      open(response);
      response.write('data: {"id":"a"}\n\n');
      setTimeout(() => response.destroy(), 10);
    } else {
      response.destroy();
    }
  });
  const { events, data } = stream(server.url, { reconnectGapsMs: [60_000] });
  await events.connected;
  await sleep(50);
  events.stop();
  const begun = Date.now();
  await events.done;
  assert.ok(Date.now() - begun < 1_000);
  assert.equal(data.length, 1);
  assert.equal(server.connections.length, 1);
});

test("an onData that throws does not end the stream", async (t) => {
  const server = await eventServer(t, (_request, response) => {
    open(response);
    response.write('data: {"id":"a"}\n\n');
    response.write('data: {"id":"b"}\n\n');
  });
  let calls = 0;
  const { events } = stream(server.url, {
    onData: () => {
      calls += 1;
      throw new Error("a bug in the caller");
    },
  });
  await events.connected;
  await until("both events", () => calls === 2 || undefined);
  assert.equal(server.connections.length, 1);
  events.stop();
  await events.done;
});
