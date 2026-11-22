// One Server-Sent Events stream of the signed-in user (docs/SPEC.md section 14).

/** The heartbeat: a data event the page's `EventSource` shows, swallowed by the page. */
const PING = `data: ${JSON.stringify({ event: "ping", payload: null })}\n\n`;

/** A client that does not read piles events up in memory; past this it is cut off and reconnects. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Open the stream: `hello` first, then every bus event for this session's user, and a `ping` data
 * event (`{"event":"ping","payload":null}`, not an event of section 14) after `pingMs` of silence.
 * It is a data event and not a comment line because a browser's `EventSource` never shows comments
 * to the page, so the page could not notice a stream that is open but dead (`src/lib/sse.ts` closes
 * a stream that was silent for 45 seconds and reconnects).
 * @param {object} options
 * @param {import("node:http").IncomingMessage} options.req
 * @param {import("node:http").ServerResponse} options.res
 * @param {import("./types.js").Session} options.session
 * @param {import("../events.js").EventBus} options.events
 * @param {string} options.instanceId
 * @param {number} options.pingMs Silence after which a ping is sent (15 s).
 * @param {() => void} [options.onEnd] Called once, however the stream ends.
 * @returns {{ end(): void }}
 */
export function openEventStream({ req, res, session, events, instanceId, pingMs, onEnd }) {
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let ended = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /** @param {string} text */
  function write(text) {
    if (ended) return;
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      cleanup();
      res.destroy();
      return;
    }
    res.write(text);
    armPing();
  }

  /** The ping is due `pingMs` after the last thing sent, whatever it was. */
  function armPing() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      write(PING);
    }, pingMs);
    timer.unref();
  }

  function cleanup() {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    unsubscribe?.();
    onEnd?.();
  }

  function end() {
    if (ended) return;
    cleanup();
    res.end();
  }

  res.on("close", cleanup);

  write(`data: ${JSON.stringify({ event: "hello", payload: { instanceId } })}\n\n`);
  unsubscribe = events.subscribe(
    { userId: session.user.id, role: session.user.role },
    (event) => {
      write(`data: ${JSON.stringify({ event: event.event, payload: event.payload ?? null })}\n\n`);
    },
    end,
  );
  // `end` can already have run if the client left while hello was written.
  if (ended) unsubscribe();
  return { end };
}
