import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBackend, type ScenarioName } from "..";
import { addUser } from "../seed/admin";
import { addJob } from "../seed/jobs";
import { ADMIN_EMAIL, ADMIN_ID, USER_EMAIL, USER_ID, USER_PASSWORD } from "../seed/session";
import { USER_CHANNEL_TRAVEL } from "../seed/workspace";
import { EMAIL_TAKEN, LAST_ADMIN_DELETE, LAST_ADMIN_DEMOTE, LAST_ADMIN_DISABLE } from "./admin";

const options = { latencyMs: 0, autoTick: false } as const;
const backends: MockBackend[] = [];

function make(scenarios: ScenarioName[] = ["default"], as: "admin" | "user" | null = "admin") {
  const backend = new MockBackend({ ...options, scenarios, as });
  backends.push(backend);
  return backend;
}

/** A second browser of the same server. */
function second(first: MockBackend, as: "admin" | "user" | null = null) {
  const backend = new MockBackend({ ...options, scenarios: ["default"], as, world: first.world });
  backends.push(backend);
  return backend;
}

afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
});

describe("mock admin area: forbidden for a user", () => {
  const calls: [string, (api: MockBackend) => Promise<unknown>][] = [
    ["adminListUsers", (api) => api.adminListUsers()],
    [
      "adminCreateUser",
      (api) => api.adminCreateUser({ email: "a@example.com", password: "12345678" }),
    ],
    ["adminUpdateUser", (api) => api.adminUpdateUser({ id: USER_ID, disabled: true })],
    ["adminDeleteUser", (api) => api.adminDeleteUser({ id: USER_ID })],
    ["adminGetSettings", (api) => api.adminGetSettings()],
    ["adminUpdateSettings", (api) => api.adminUpdateSettings({ maxEdits: 4 })],
    ["adminGetQueue", (api) => api.adminGetQueue()],
    ["adminSetJobUrgent", (api) => api.adminSetJobUrgent({ jobId: "x", urgent: true })],
    ["adminStartJobNow", (api) => api.adminStartJobNow({ jobId: "x" })],
  ];

  it.each(calls)(
    "%s answers forbidden to a user and unauthenticated to nobody",
    async (_n, call) => {
      await expect(call(make(["as-user"], "user"))).rejects.toMatchObject({ code: "forbidden" });
      await expect(call(make(["signed-out"], null))).rejects.toMatchObject({
        code: "unauthenticated",
      });
    },
  );
});

describe("mock admin area: users", () => {
  it("lists the accounts with their active jobs", async () => {
    const backend = make();
    const now = Date.now();
    addJob(
      backend.world,
      { channelId: USER_CHANNEL_TRAVEL, folderName: "Trip", userId: USER_ID, state: "running" },
      now,
    );
    const users = await backend.adminListUsers();
    expect(users.map((u) => u.email)).toEqual([ADMIN_EMAIL, USER_EMAIL]);
    expect(users.find((u) => u.id === USER_ID)).toMatchObject({
      role: "user",
      disabled: false,
      mayMarkUrgent: false,
      activeJobs: 1,
    });
    expect(users[0]).not.toHaveProperty("password");
  });

  it("creates an account: trimmed lower-case email, role user and Urgent allowed by default", async () => {
    const backend = make();
    const created = await backend.adminCreateUser({
      email: "  New.Person@Example.com ",
      password: "long-enough-password",
    });
    expect(created).toMatchObject({
      email: "new.person@example.com",
      role: "user",
      disabled: false,
      mayMarkUrgent: true,
      lastSeenAt: null,
      activeJobs: 0,
    });
    expect(created).not.toHaveProperty("password");
    const other = second(backend);
    await other.login({ email: "new.person@example.com", password: "long-enough-password" });
    expect((await other.getSession()).user?.role).toBe("user");
  });

  it("refuses an email that exists, a bad email and a bad password at their field", async () => {
    const backend = make();
    await expect(
      backend.adminCreateUser({
        email: USER_EMAIL.toUpperCase(),
        password: "long-enough-password",
      }),
    ).rejects.toMatchObject({ code: "conflict", message: EMAIL_TAKEN });
    await expect(
      backend.adminCreateUser({ email: "no-at-sign", password: "long-enough-password" }),
    ).rejects.toMatchObject({ code: "invalidInput", message: /valid email address/ });
    await expect(
      backend.adminCreateUser({ email: "x@example.com", password: "short" }),
    ).rejects.toMatchObject({ code: "invalidInput", message: /8 to 200 characters/ });
    expect(await backend.adminListUsers()).toHaveLength(2);
  });

  it("edits email, role, Urgent and disabled, and refuses an email in use", async () => {
    const backend = make();
    const updated = await backend.adminUpdateUser({
      id: USER_ID,
      email: "Renamed@Example.com",
      role: "admin",
      mayMarkUrgent: true,
    });
    expect(updated).toMatchObject({
      email: "renamed@example.com",
      role: "admin",
      mayMarkUrgent: true,
    });
    await expect(
      backend.adminUpdateUser({ id: USER_ID, email: ADMIN_EMAIL }),
    ).rejects.toMatchObject({ code: "conflict", message: EMAIL_TAKEN });
    await expect(backend.adminUpdateUser({ id: "nobody" })).rejects.toMatchObject({
      code: "notFound",
    });
  });

  it("never lets the last enabled admin be demoted, disabled or deleted", async () => {
    const backend = make();
    await expect(backend.adminUpdateUser({ id: ADMIN_ID, role: "user" })).rejects.toMatchObject({
      code: "conflict",
      message: LAST_ADMIN_DEMOTE,
      field: "role",
    });
    await expect(backend.adminUpdateUser({ id: ADMIN_ID, disabled: true })).rejects.toMatchObject({
      code: "conflict",
      message: LAST_ADMIN_DISABLE,
      field: "disabled",
    });
    await expect(backend.adminDeleteUser({ id: ADMIN_ID })).rejects.toMatchObject({
      code: "conflict",
      message: LAST_ADMIN_DELETE,
    });
    // A disabled admin does not count: with the second admin disabled, the first is the last.
    const other = addUser(backend.world, { email: "other@example.com", role: "admin" });
    other.disabled = true;
    await expect(backend.adminDeleteUser({ id: ADMIN_ID })).rejects.toMatchObject({
      code: "conflict",
    });
    other.disabled = false;
    await expect(backend.adminUpdateUser({ id: ADMIN_ID, role: "user" })).resolves.toMatchObject({
      role: "user",
    });
  });

  it("disabling an account ends its sessions and stops its jobs", async () => {
    const backend = make();
    const now = Date.now();
    const running = addJob(
      backend.world,
      { channelId: USER_CHANNEL_TRAVEL, folderName: "Trip", userId: USER_ID, state: "running" },
      now,
    );
    const waiting = addJob(
      backend.world,
      { channelId: USER_CHANNEL_TRAVEL, folderName: "Hike", userId: USER_ID, state: "queued" },
      now,
    );
    const browser = second(backend, "user");
    const ended = vi.fn();
    browser.on.sessionEnded(ended);
    await backend.adminUpdateUser({ id: USER_ID, disabled: true });
    expect(ended).toHaveBeenCalledWith({ reason: "disabled" });
    expect((await browser.getSession()).user).toBeNull();
    expect(running.view.state).toBe("stopping");
    expect(waiting.view.state).toBe("stopped");
    await expect(
      second(backend).login({ email: USER_EMAIL, password: USER_PASSWORD }),
    ).rejects.toMatchObject({ code: "invalidInput" });
  });

  it("a new password ends the other sessions of the account but not the admin's own", async () => {
    const backend = make();
    const other = second(backend);
    await other.login({ email: ADMIN_EMAIL, password: "admin-password" });
    const ended = vi.fn();
    other.on.sessionEnded(ended);
    await backend.adminUpdateUser({ id: ADMIN_ID, password: "brand-new-password" });
    expect(ended).toHaveBeenCalledWith({ reason: "passwordChanged" });
    expect((await other.getSession()).user).toBeNull();
    expect((await backend.getSession()).user?.id).toBe(ADMIN_ID);
  });

  it("deleting an account signs its other browser out, removes its jobs and channels", async () => {
    const backend = make();
    const now = Date.now();
    addJob(
      backend.world,
      { channelId: USER_CHANNEL_TRAVEL, folderName: "Trip", userId: USER_ID, state: "running" },
      now,
    );
    const browser = second(backend, "user");
    const ended = vi.fn();
    browser.on.sessionEnded(ended);
    expect((await browser.getSession()).user?.id).toBe(USER_ID);
    expect(await backend.adminDeleteUser({ id: USER_ID })).toBeNull();
    expect(ended).toHaveBeenCalledWith({ reason: "removed" });
    expect((await browser.getSession()).user).toBeNull();
    expect((await backend.adminListUsers()).map((u) => u.id)).toEqual([ADMIN_ID]);
    expect(backend.world.jobs.some((job) => job.view.userId === USER_ID)).toBe(false);
    expect(backend.world.channels.some((c) => c.userId === USER_ID)).toBe(false);
    await expect(backend.adminDeleteUser({ id: USER_ID })).rejects.toMatchObject({
      code: "notFound",
    });
  });

  it("an admin may delete themself while another enabled admin exists", async () => {
    const backend = make();
    addUser(backend.world, { email: "second@example.com", role: "admin" });
    await backend.adminDeleteUser({ id: ADMIN_ID });
    expect((await backend.getSession()).user).toBeNull();
  });
});

describe("mock admin area: settings", () => {
  it("returns the settings and applies a partial change, clamped like the server", async () => {
    const backend = make();
    expect((await backend.adminGetSettings()).maxEdits).toBe(3);
    const after = await backend.adminUpdateSettings({
      maxEdits: 99,
      maxRenders: 0,
      maxEditsPerUser: 0,
      startDelayMinutes: 7.4,
      maxModelRetries: 51,
      maxUploadGb: 0,
      proxyCacheGb: 5000,
    });
    expect(after).toMatchObject({
      maxEdits: 8,
      maxRenders: 1,
      maxEditsPerUser: 0,
      startDelayMinutes: 7,
      maxModelRetries: 50,
      maxUploadGb: 1,
      proxyCacheGb: 2000,
      maxTimelineEdits: 2,
    });
    expect(await backend.adminGetSettings()).toEqual(after);
  });

  it("takes CPU and GPU limits in steps of 5 from 5 to 100", async () => {
    const backend = make();
    const after = await backend.adminUpdateSettings({
      cpuPerEditPercent: 7,
      cpuTotalPercent: 3,
      gpuPerEditPercent: 98,
      gpuTotalPercent: 250,
    });
    expect(after).toMatchObject({
      cpuPerEditPercent: 5,
      cpuTotalPercent: 5,
      gpuPerEditPercent: 100,
      gpuTotalPercent: 100,
    });
    // A per-edit value above the total is kept (the engine uses the lower one).
    const mixed = await backend.adminUpdateSettings({ cpuPerEditPercent: 80, cpuTotalPercent: 40 });
    expect(mixed).toMatchObject({ cpuPerEditPercent: 80, cpuTotalPercent: 40 });
  });

  it("refuses unknown keys and wrong types and changes nothing", async () => {
    const backend = make();
    await expect(
      backend.adminUpdateSettings({ maxEdits: 5, bogus: 1 } as never),
    ).rejects.toMatchObject({
      code: "invalidInput",
      message: 'There is no setting called "bogus".',
    });
    await expect(backend.adminUpdateSettings({ maxEdits: "5" } as never)).rejects.toMatchObject({
      code: "invalidInput",
      message: 'The setting "maxEdits" must be a number.',
    });
    expect((await backend.adminGetSettings()).maxEdits).toBe(3);
  });

  it("cleans storage folders: full paths only, no duplicates, no trailing slash", async () => {
    const backend = make();
    const after = await backend.adminUpdateSettings({
      storageRoots: ["/srv/media/", "/srv/other", " /srv/media ", "/srv/x/../other"],
    });
    expect(after.storageRoots).toEqual(["/srv/media", "/srv/other"]);
    await expect(
      backend.adminUpdateSettings({ storageRoots: ["relative/dir"] }),
    ).rejects.toMatchObject({
      code: "invalidInput",
      message: '"relative/dir" is not a full folder path.',
    });
    await expect(backend.adminUpdateSettings({ storageRoots: [""] })).rejects.toMatchObject({
      code: "invalidInput",
    });
    expect((await backend.adminGetSettings()).storageRoots).toEqual(["/srv/media", "/srv/other"]);
  });

  it("announces the public settings to everybody and plans the queues again", async () => {
    const backend = make();
    const user = second(backend, "user");
    const changed = vi.fn();
    const queue = vi.fn();
    user.on.settingsChanged(changed);
    user.on.queueChanged(queue);
    await backend.adminUpdateSettings({ maxEditsPerUser: 1, startDelayMinutes: 3 });
    expect(changed).toHaveBeenCalledWith({
      setup: "claudeSubscription",
      maxUploadGb: 50,
      maxEditsPerUser: 1,
      startDelayMinutes: 3,
    });
    expect(queue).toHaveBeenCalled();
    await expect(user.adminGetSettings()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("starts waiting edits when more slots are allowed", async () => {
    const backend = make(["queue-full"]);
    const before = await backend.adminGetQueue();
    const waiting = before.jobs.filter((j) => j.queue === "edits" && j.state === "queued");
    expect(waiting.length).toBeGreaterThan(0);
    await backend.adminUpdateSettings({ maxEdits: 8, maxEditsPerUser: 0, startDelayMinutes: 0 });
    const after = await backend.adminGetQueue();
    expect(after.jobs.filter((j) => j.queue === "edits" && j.state === "queued")).toHaveLength(0);
  });
});

describe("mock admin area: queue", () => {
  it("lists everybody's jobs with the user's email, in queue order", async () => {
    const backend = make(["urgent"]);
    const view = await backend.adminGetQueue();
    expect(view.queues).toHaveLength(3);
    const edits = view.jobs.filter((j) => j.queue === "edits");
    expect(edits.map((j) => j.state)).toEqual(["running", "queued", "queued", "queued"]);
    expect(edits.some((j) => j.userEmail === USER_EMAIL)).toBe(true);
    expect(edits.find((j) => j.folderName === "Webcam Comparison")).toMatchObject({
      urgent: true,
      position: 1,
    });
  });

  it("Urgent and Start now change the order and the answer", async () => {
    const backend = make(["urgent"]);
    const view = await backend.adminGetQueue();
    const plain = view.jobs.find((j) => j.folderName === "Desk Lamp Review");
    if (!plain) throw new Error("seed job missing");
    expect(plain.position).toBe(2);
    const job = await backend.adminSetJobUrgent({ jobId: plain.jobId, urgent: true });
    expect(job.urgent).toBe(true);
    const after = await backend.adminGetQueue();
    const waiting = after.jobs.filter((j) => j.state === "queued").map((j) => j.folderName);
    expect(waiting[0]).toBe("Desk Lamp Review");
    await backend.adminSetJobUrgent({ jobId: plain.jobId, urgent: false });
    const back = await backend.adminGetQueue();
    expect(back.jobs.filter((j) => j.state === "queued").map((j) => j.folderName)).toEqual([
      "Webcam Comparison",
      "Desk Lamp Review",
      "Porto Food Tour",
    ]);
  });

  it("Start now lets an edit held by the start delay go", async () => {
    const backend = make(["start-delay"]);
    const held = (await backend.adminGetQueue()).jobs.find((j) => j.folderName === "Held A");
    expect(held?.startsAt).not.toBeNull();
    await backend.adminStartJobNow({ jobId: held?.jobId ?? "" });
    const after = (await backend.adminGetQueue()).jobs.find((j) => j.folderName === "Held A");
    expect(after?.state).toBe("running");
    await expect(backend.adminStartJobNow({ jobId: "nope" })).rejects.toMatchObject({
      code: "notFound",
    });
  });
});
