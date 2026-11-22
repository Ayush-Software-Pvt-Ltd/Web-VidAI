/**
 * The mock backend: one browser talking to an in-memory server. It builds the `MockCtx` and merges
 * the area modules in `areas/` (each `(ctx) => Partial<Api>`); a function no area implements
 * yet throws "not implemented in the mock yet: <name>". Several backends can share one `World`
 * (`options.world`) to act as several browsers of the same server (two users, events between them).
 */
import type { Api, ApiEvents, FileUrlOptions, RpcApi, Uploads } from "../api";
import { PLAYER_SCRIPT_URL } from "../api";
import { createConnectionStore, type ConnectionStore } from "../connection";
import { createEventHub, type EventHub } from "../eventHub";
import { ApiError } from "../errors";
import { buildFileUrl } from "../http";
import { makeVideoId } from "../videoId";
import { RPC_NAMES, type EventName, type EventPayloads } from "../rpc";
import { adminArea } from "./areas/admin";
import { adminChannelsArea } from "./areas/adminChannels";
import { diskArea } from "./areas/disk";
import { harnessArea } from "./areas/harness";
import { jobsArea } from "./areas/jobs";
import { libraryArea } from "./areas/library";
import { queueArea } from "./areas/queue";
import { sessionArea } from "./areas/session";
import { storageArea } from "./areas/storage";
import { systemArea } from "./areas/system";
import { timelineArea } from "./areas/timeline";
import { uploadsArea } from "./areas/uploads";
import { workspaceArea } from "./areas/workspace";
import { mockFileUrl } from "./files";
import { createErrors, type EventTarget, type MockCtx, type TickRegistry } from "./ctx";
import { buildWorld, DEFAULT_MOCK_OPTIONS, type MockOptions } from "./scenarios";
import { nextId, type World } from "./world";

/** One browser of a world: where its events go and which session it holds. */
interface Peer {
  token: () => string | null;
  clearToken: () => void;
  hub: EventHub;
}

const peersOf = new WeakMap<World, Set<Peer>>();

const AREAS = [
  sessionArea,
  workspaceArea,
  libraryArea,
  jobsArea,
  queueArea,
  storageArea,
  uploadsArea,
  adminArea,
  adminChannelsArea,
  harnessArea,
  timelineArea,
  diskArea,
  systemArea,
];

function notImplemented(name: string): () => Promise<never> {
  return () => Promise.reject(new ApiError("internal", `not implemented in the mock yet: ${name}`));
}

/** The RPC functions are installed on the instance by the constructor; this types them. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface MockBackend extends RpcApi {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class MockBackend implements Api {
  readonly backend = "mock" as const;
  readonly world: World;
  readonly options: MockOptions;
  readonly connection: ConnectionStore;
  readonly on: ApiEvents;
  readonly playerScriptUrl = PLAYER_SCRIPT_URL;
  readonly uploads: Uploads;
  readonly ctx: MockCtx;

  private token: string | null = null;
  private readonly hub = createEventHub();
  private readonly peer: Peer;
  private readonly works = new Map<string, (now: number) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly functions: Record<string, unknown> = {};

  constructor(options: Partial<MockOptions> = {}) {
    this.options = { ...DEFAULT_MOCK_OPTIONS, ...options };
    this.world = this.options.world ?? buildWorld(this.options.scenarios);
    this.connection = createConnectionStore({ status: "connected", instance: "mock" });
    this.on = this.hub.on;
    this.peer = {
      token: () => this.token,
      clearToken: () => {
        this.token = null;
      },
      hub: this.hub,
    };
    const peers = peersOf.get(this.world) ?? new Set<Peer>();
    peersOf.set(this.world, peers);
    peers.add(this.peer);

    this.startSession();
    this.ctx = this.buildCtx(peers);
    for (const area of AREAS) Object.assign(this.functions, area(this.ctx));
    for (const name of RPC_NAMES) this.functions[name] ??= notImplemented(name);
    this.uploads = (this.functions["uploads"] as Uploads | undefined) ?? {
      send: notImplemented("uploads.send"),
      state: notImplemented("uploads.state"),
    };
    // The RPC functions are plain properties of the instance (the `Api` is a flat object).
    for (const name of RPC_NAMES)
      Object.defineProperty(this, name, { value: this.functions[name] });

    if (this.options.autoTick) {
      this.timer = setInterval(() => this.tick(), 1000);
    }
  }

  fileUrl(videoId: string, path: string, options: FileUrlOptions = {}): string {
    // The server's `GET /api/file` refuses a file of a channel whose folder cannot be reached
    // (`folders.resolveVideo`), so such a file gets the plain route, which serves nothing here.
    const video = this.world.videos.find((v) => makeVideoId(v.channelId, v.folderName) === videoId);
    const channel = this.world.channels.find((c) => c.id === video?.channelId);
    if (channel && !channel.available) return buildFileUrl(videoId, path, options);
    return mockFileUrl(videoId, path, options);
  }

  /** Runs every registered tick work once (tests call this instead of waiting). */
  tick(): void {
    const now = Date.now();
    for (const work of [...this.works.values()]) work(now);
  }

  /**
   * This browser's session expires as on the server after 30 idle days (`server/src/auth/
   * sessions.js`): nothing is announced, the next call answers `unauthenticated` "Sign in to
   * continue.". (Sign out, a password change, disabling and deleting do announce `session-ended`.)
   */
  expireSession(): void {
    if (this.token) this.world.sessions.delete(this.token);
  }

  /** Stops the timers and drops the subscribers (also leaves the world's peers). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hub.clear();
    peersOf.get(this.world)?.delete(this.peer);
  }

  private startSession(): void {
    const as = this.options.as === undefined ? this.world.startAs : this.options.as;
    if (as === null) return;
    const user = this.world.users.find((candidate) => candidate.role === as && !candidate.disabled);
    if (!user) return;
    this.token = nextId(this.world, "session");
    this.world.sessions.set(this.token, { userId: user.id });
  }

  private buildCtx(peers: Set<Peer>): MockCtx {
    const world = this.world;
    const errors = createErrors();
    const ticks: TickRegistry = {
      register: (name, work) => {
        this.works.set(name, work);
        return () => {
          this.works.delete(name);
        };
      },
      tick: () => this.tick(),
    };
    const user = () => {
      const session = this.token ? world.sessions.get(this.token) : undefined;
      const found = session && world.users.find((candidate) => candidate.id === session.userId);
      return found && !found.disabled ? found : null;
    };
    const requireUser = () => {
      const found = user();
      if (!found) throw errors.unauthenticated();
      return found;
    };
    const ctx: MockCtx = {
      world,
      options: { latencyMs: this.options.latencyMs, autoTick: this.options.autoTick },
      clock: { now: () => Date.now(), minuteMs: this.options.minuteMs, speed: this.options.speed },
      ticks,
      errors,
      connection: this.connection,
      user,
      requireUser,
      requireAdmin: () => {
        const found = requireUser();
        if (found.role !== "admin") throw errors.forbidden();
        return found;
      },
      session: {
        get: () => this.token,
        set: (token) => {
          this.token = token;
        },
      },
      endSessions: (userId, { exceptToken = null, reason }) => {
        let ended = 0;
        for (const [token, session] of [...world.sessions]) {
          if (session.userId !== userId || token === exceptToken) continue;
          world.sessions.delete(token);
          ended += 1;
          for (const peer of peers) {
            if (peer.token() !== token) continue;
            peer.clearToken();
            peer.hub.emit("session-ended", { reason });
          }
        }
        return ended;
      },
      emit: <E extends EventName>(event: E, payload: EventPayloads[E], to?: EventTarget) => {
        for (const peer of peers) {
          const session = peer.token() ? world.sessions.get(peer.token() as string) : undefined;
          const who = session && world.users.find((candidate) => candidate.id === session.userId);
          if (!who) continue;
          const targeted = to && (to.userId != null || to.admins);
          if (targeted && !(who.id === to.userId || (to.admins && who.role === "admin"))) continue;
          peer.hub.emit(event, structuredClone(payload));
        }
      },
      emitHere: (event, payload) => this.hub.emit(event, structuredClone(payload)),
      run: <T>(work: () => T): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const finish = () => {
            try {
              resolve(structuredClone(work()));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
          if (this.options.latencyMs > 0) setTimeout(finish, this.options.latencyMs);
          else queueMicrotask(finish);
        }),
    };
    return ctx;
  }
}
