/**
 * The admin area (done): accounts (`adminListUsers`, `adminCreateUser`, `adminUpdateUser`,
 * `adminDeleteUser`), the queue, upload and cache settings (`adminGetSettings`, `adminUpdateSettings`)
 * and the admin's queue (`adminGetQueue`, `adminSetJobUrgent`, `adminStartJobNow`). Every function
 * answers `forbidden` to a user. It behaves like `server/src/rpc/adminUsers.js`, `adminSettings.js`
 * and `queue.js`:
 * - the email is trimmed and lower-cased, must be new (`conflict`), the password has 8 to 200
 *   characters, the role defaults to `user` and `mayMarkUrgent` to true;
 * - the last enabled admin can be neither disabled, made a user nor deleted (`conflict`); an admin
 *   may delete or demote themself while another enabled admin exists;
 * - disabling or deleting an account ends its sessions (`session-ended` with the reason) and stops
 *   its active jobs; deleting also removes its jobs, channels and videos from the mock world;
 *   a new password ends the account's other sessions;
 * - a settings change is checked and clamped like `server/src/settings.js`, the queues are planned
 *   again and `settings-changed` (public part) and `queue-changed` are sent to everybody.
 */
import type { Api } from "../../api";
import { ApiError } from "../../errors";
import type { AdminSettings, Role, Setup, UserAccount } from "../../types";
import { splitVideoId } from "../../videoId";
import type { MockCtx } from "../ctx";
import { QUEUES, viewOf } from "../queue";
import { isActiveState } from "../rules";
import { nextId, type MockUser } from "../world";
import { adminQueue, adminSetJobUrgent, adminStartJobNow } from "./queue";
import { kick } from "./jobs";
import { validateEmail, validatePassword } from "./session";

export const NO_SUCH_ACCOUNT = "This account does not exist.";
export const EMAIL_TAKEN = "An account with this email already exists.";
export const LAST_ADMIN_DELETE =
  "The last admin cannot be deleted. Make another account an admin first.";
export const LAST_ADMIN_DEMOTE =
  "The last admin cannot be made a user. Make another account an admin first.";
export const LAST_ADMIN_DISABLE =
  "The last admin cannot be disabled. Make another account an admin first.";

const SETUPS: readonly Setup[] = ["claudeSubscription", "opencodeGo", "anthropicApi", "openaiApi"];
const ROLES: readonly Role[] = ["admin", "user"];
const PERCENT_STEP = 5;

type Definition =
  { kind: "int"; min: number; max: number } | { kind: "percent" } | { kind: "setup" };

/** The ranges of SPEC section 5, as `server/src/settings.js` has them. */
export const DEFINITIONS: Record<keyof AdminSettings, Definition> = {
  setup: { kind: "setup" },
  maxEdits: { kind: "int", min: 1, max: 8 },
  maxTimelineEdits: { kind: "int", min: 1, max: 8 },
  maxRenders: { kind: "int", min: 1, max: 4 },
  maxEditsPerUser: { kind: "int", min: 0, max: 8 },
  startDelayMinutes: { kind: "int", min: 0, max: 120 },
  maxModelRetries: { kind: "int", min: 0, max: 50 },
  cpuPerEditPercent: { kind: "percent" },
  cpuTotalPercent: { kind: "percent" },
  gpuPerEditPercent: { kind: "percent" },
  gpuTotalPercent: { kind: "percent" },
  maxUploadGb: { kind: "int", min: 1, max: 2000 },
  proxyCacheGb: { kind: "int", min: 1, max: 2000 },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function sanitize(ctx: MockCtx, key: string, definition: Definition, value: unknown): unknown {
  switch (definition.kind) {
    case "int":
    case "percent": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw ctx.errors.invalidInput(`The setting "${key}" must be a number.`);
      }
      if (definition.kind === "percent") {
        return clamp(Math.round(value / PERCENT_STEP) * PERCENT_STEP, PERCENT_STEP, 100);
      }
      return clamp(Math.round(value), definition.min, definition.max);
    }
    case "setup": {
      const setup = SETUPS.find((candidate) => candidate === value);
      if (!setup) {
        throw ctx.errors.invalidInput(`The setting "${key}" must be one of ${SETUPS.join(", ")}.`);
      }
      return setup;
    }
  }
}

function accountOf(ctx: MockCtx, user: MockUser): UserAccount {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    disabled: user.disabled,
    mayMarkUrgent: user.mayMarkUrgent,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    activeJobs: ctx.world.jobs.filter(
      (job) => job.view.userId === user.id && isActiveState(job.view.state),
    ).length,
  };
}

const enabledAdmins = (ctx: MockCtx) =>
  ctx.world.users.filter((user) => user.role === "admin" && !user.disabled).length;

const isEnabledAdmin = (user: MockUser) => user.role === "admin" && !user.disabled;

function emitQueues(ctx: MockCtx, queues: Iterable<(typeof QUEUES)[number]>): void {
  for (const queue of new Set(queues)) ctx.emit("queue-changed", { queue });
}

/** What the server's job engine does when an account is disabled (`manager.stopJobsOf`). */
function stopJobsOf(ctx: MockCtx, userId: string): void {
  const now = ctx.clock.now();
  const clock = { now, minuteMs: ctx.clock.minuteMs };
  const touched = new Set<(typeof QUEUES)[number]>();
  for (const job of ctx.world.jobs) {
    if (job.view.userId !== userId) continue;
    const { view } = job;
    if (view.state === "queued" || view.state === "paused") {
      view.state = "stopped";
      view.endedAt = now;
      view.runningSince = null;
      view.position = null;
      view.startsAt = null;
    } else if (view.state === "running" || view.state === "pausing") {
      view.state = "stopping";
    } else continue;
    touched.add(view.queue);
    ctx.emit("job-updated", viewOf(ctx.world, job, clock), { userId, admins: true });
  }
  emitQueues(ctx, touched);
  kick(ctx);
}

/** What deleting an account leaves of it: nothing in the database (its files stay on disk). */
function removeAccountData(ctx: MockCtx, userId: string): void {
  const { world } = ctx;
  const touched = new Set<(typeof QUEUES)[number]>();
  const gone = new Set(
    world.jobs.filter((job) => job.view.userId === userId).map((job) => job.view.id),
  );
  for (const job of world.jobs) if (gone.has(job.view.id)) touched.add(job.view.queue);
  world.jobs = world.jobs.filter((job) => !gone.has(job.view.id));
  world.jobLogs = Object.fromEntries(Object.entries(world.jobLogs).filter(([id]) => !gone.has(id)));
  const channelIds = new Set(
    world.channels.filter((channel) => channel.userId === userId).map((channel) => channel.id),
  );
  world.channels = world.channels.filter((channel) => channel.userId !== userId);
  world.videos = world.videos.filter((video) => video.userId !== userId);
  world.archived = world.archived.filter(
    (entry) => !channelIds.has(splitVideoId(entry.videoId)?.channelId ?? ""),
  );
  world.uploads = world.uploads.filter(
    (upload) => upload.userId !== userId && !channelIds.has(upload.channelId),
  );
  world.users = world.users.filter((user) => user.id !== userId);
  emitQueues(ctx, touched);
  kick(ctx);
}

export function adminArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  return {
    adminListUsers: () =>
      ctx.run(() => {
        ctx.requireAdmin();
        return world.users.map((user) => accountOf(ctx, user));
      }),

    adminCreateUser: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const email = validateEmail(ctx, input.email);
        const password = validatePassword(ctx, input.password);
        const role = input.role ?? "user";
        if (!ROLES.includes(role))
          throw new ApiError("invalidInput", "The role is not valid.", "role");
        if (world.users.some((user) => user.email === email)) {
          throw new ApiError("conflict", EMAIL_TAKEN, "email");
        }
        const user: MockUser = {
          id: nextId(world, "user"),
          email,
          password,
          role,
          disabled: false,
          mayMarkUrgent: input.mayMarkUrgent ?? true,
          createdAt: ctx.clock.now(),
          lastSeenAt: null,
        };
        world.users.push(user);
        return accountOf(ctx, user);
      }),

    adminUpdateUser: (input) =>
      ctx.run(() => {
        const admin = ctx.requireAdmin();
        const target = world.users.find((user) => user.id === input.id);
        if (!target) throw ctx.errors.notFound(NO_SUCH_ACCOUNT);
        const email = input.email == null ? undefined : validateEmail(ctx, input.email);
        const password = input.password == null ? undefined : validatePassword(ctx, input.password);
        if (
          email !== undefined &&
          world.users.some((u) => u.id !== target.id && u.email === email)
        ) {
          throw new ApiError("conflict", EMAIL_TAKEN, "email");
        }
        const role = input.role ?? target.role;
        const disabled = input.disabled ?? target.disabled;
        if (isEnabledAdmin(target) && !(role === "admin" && !disabled) && enabledAdmins(ctx) <= 1) {
          throw role !== "admin"
            ? new ApiError("conflict", LAST_ADMIN_DEMOTE, "role")
            : new ApiError("conflict", LAST_ADMIN_DISABLE, "disabled");
        }
        const wasDisabled = target.disabled;
        if (email !== undefined) target.email = email;
        if (password !== undefined) target.password = password;
        target.role = role;
        target.disabled = disabled;
        if (input.mayMarkUrgent != null) target.mayMarkUrgent = input.mayMarkUrgent;

        const isSelf = target.id === admin.id;
        if (disabled && !wasDisabled) {
          ctx.endSessions(target.id, { reason: "disabled" });
          stopJobsOf(ctx, target.id);
        } else if (password !== undefined) {
          ctx.endSessions(target.id, {
            exceptToken: isSelf ? ctx.session.get() : null,
            reason: "passwordChanged",
          });
        }
        return accountOf(ctx, target);
      }),

    adminDeleteUser: ({ id }) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const target = world.users.find((user) => user.id === id);
        if (!target) throw ctx.errors.notFound(NO_SUCH_ACCOUNT);
        if (isEnabledAdmin(target) && enabledAdmins(ctx) <= 1) {
          throw ctx.errors.conflict(LAST_ADMIN_DELETE);
        }
        ctx.endSessions(id, { reason: "removed" });
        removeAccountData(ctx, id);
        return null;
      }),

    adminGetSettings: () =>
      ctx.run(() => {
        ctx.requireAdmin();
        return { ...world.adminSettings };
      }),

    adminUpdateSettings: (patch) =>
      ctx.run(() => {
        ctx.requireAdmin();
        if (typeof patch !== "object" || Array.isArray(patch)) {
          throw ctx.errors.invalidInput("The settings change must be an object.");
        }
        const clean: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
          if (!Object.hasOwn(DEFINITIONS, key)) {
            throw ctx.errors.invalidInput(`There is no setting called "${key}".`);
          }
          clean[key] = sanitize(ctx, key, DEFINITIONS[key as keyof AdminSettings], value);
        }
        Object.assign(world.adminSettings, clean);
        const { setup, maxUploadGb, maxEditsPerUser, startDelayMinutes } = world.adminSettings;
        ctx.emit("settings-changed", { setup, maxUploadGb, maxEditsPerUser, startDelayMinutes });
        // The queues are planned again with the new limits.
        kick(ctx);
        emitQueues(ctx, QUEUES);
        return { ...world.adminSettings };
      }),

    adminGetQueue: () =>
      ctx.run(() => {
        ctx.requireAdmin();
        return adminQueue(ctx);
      }),

    adminSetJobUrgent: ({ jobId, urgent }) =>
      ctx.run(() => {
        ctx.requireAdmin();
        return adminSetJobUrgent(ctx, jobId, urgent);
      }),

    adminStartJobNow: ({ jobId }) =>
      ctx.run(() => {
        ctx.requireAdmin();
        return adminStartJobNow(ctx, jobId);
      }),
  };
}
