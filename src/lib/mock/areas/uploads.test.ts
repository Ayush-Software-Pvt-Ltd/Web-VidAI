import { describe, expect, it } from "vitest";
import { isAbortError } from "../../errors";
import type { Library } from "../../types";
import { MockBackend } from "../backend";
import { ADMIN_ID } from "../seed/session";
import { HAIR_OIL_ID } from "../seed/uploads";
import { ADMIN_CHANNEL_TECH, USER_CHANNEL_TRAVEL } from "../seed/workspace";
import { makeVideoId } from "../../videoId";
import { ADMIN_CHANNEL_BEAUTY } from "../seed/workspace";
import { MAX_CHUNK_BYTES, UPLOAD_TICKS } from "./uploads";

const options = { latencyMs: 0, autoTick: false } as const;
const NIGHT_CREAM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream");

function backendOf(scenarios: ("default" | "uploading")[] = ["default"], as?: "admin" | "user") {
  return new MockBackend({ ...options, scenarios, ...(as ? { as } : {}) });
}

async function ticketFor(backend: MockBackend, name = "clip.mp4", size = 1000) {
  return backend.createUpload({ target: { kind: "video", videoId: NIGHT_CREAM }, name, size });
}

const channelTarget = { kind: "channel", channelId: ADMIN_CHANNEL_BEAUTY } as const;

const settle = async () => {
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
};

describe("mock uploads area: createUpload", () => {
  it("answers a ticket and marks the video as uploading", async () => {
    const backend = backendOf();
    expect(
      (await backend.getLibrary()).channels[0]?.videos.find((v) => v.id === NIGHT_CREAM),
    ).toMatchObject({ uploading: false });
    const ticket = await ticketFor(backend);
    expect(ticket).toMatchObject({ name: "clip.mp4", size: 1000, maxChunkBytes: MAX_CHUNK_BYTES });
    expect(ticket.id).not.toBe("");
    const library = await backend.getLibrary();
    const video = library.channels.flatMap((c) => c.videos).find((v) => v.id === NIGHT_CREAM);
    expect(video?.uploading).toBe(true);
    expect(video?.actions).not.toContain("startEdit");
    expect(video?.actions).toContain("upload");
    backend.dispose();
  });

  it.each([
    ["a/b.mp4", /slashes/],
    ["a\\b.mp4", /slashes/],
    [".hidden.mp4", /start with a dot/],
    ["name.", /end with a dot or a space/],
    ["name ", /end with a dot or a space/],
    ["bad\u0007name", /control characters/],
    ["", /1 to 200 characters/],
    ["x".repeat(201), /1 to 200 characters/],
    ["CON.txt", /Windows does not allow/],
  ] as const)("refuses the name %j", async (name, message) => {
    const backend = backendOf();
    await expect(ticketFor(backend, name)).rejects.toMatchObject({ code: "invalidInput" });
    await expect(ticketFor(backend, name)).rejects.toThrow(message);
    backend.dispose();
  });

  it.each(["notes.exe", "noextension", "archive.zip", "Brand Kit (final).PSD", "x".repeat(200)])(
    "accepts any file type: %s",
    async (name) => {
      const backend = backendOf();
      await expect(ticketFor(backend, name)).resolves.toMatchObject({ name });
      backend.dispose();
    },
  );

  it("refuses an empty file and a file over the limit with tooLarge", async () => {
    const backend = backendOf();
    await expect(ticketFor(backend, "a.mp4", 0)).rejects.toMatchObject({
      code: "invalidInput",
      message: "That file is empty.",
    });
    const limit = backend.world.adminSettings.maxUploadGb * 1024 ** 3;
    await expect(ticketFor(backend, "big.mp4", limit + 1)).rejects.toMatchObject({
      code: "tooLarge",
      message: `A file can be at most ${backend.world.adminSettings.maxUploadGb} GB.`,
    });
    backend.dispose();
  });

  it("refuses a name that exists in the folder, free in the other folders", async () => {
    const backend = backendOf();
    const hairOil = { kind: "video", videoId: HAIR_OIL_ID } as const;
    await expect(
      backend.createUpload({ target: hairOil, name: "LOGO.png", size: 10 }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "A file with this name already exists in this folder.",
    });
    // The channel's upload folder and another video's folder are other folders.
    await expect(
      backend.createUpload({ target: channelTarget, name: "logo.png", size: 10 }),
    ).resolves.toMatchObject({ name: "logo.png" });
    await expect(ticketFor(backend, "logo.png")).resolves.toMatchObject({ name: "logo.png" });
    // A channel file name is taken in the channel folder only.
    await expect(
      backend.createUpload({ target: channelTarget, name: "brand-kit.zip", size: 10 }),
    ).rejects.toMatchObject({ code: "conflict" });
    backend.dispose();
  });

  it("refuses a name that is being uploaded", async () => {
    const backend = backendOf();
    await ticketFor(backend);
    await expect(ticketFor(backend)).rejects.toMatchObject({
      code: "conflict",
      message: "A file with this name is already being uploaded.",
    });
    backend.dispose();
  });

  it("answers notFound for a video that does not exist", async () => {
    const backend = backendOf();
    await expect(
      backend.createUpload({
        target: { kind: "video", videoId: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Nope") },
        name: "a.mp4",
        size: 10,
      }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      backend.createUpload({
        target: { kind: "channel", channelId: "nope" },
        name: "a.mp4",
        size: 10,
      }),
    ).rejects.toMatchObject({ code: "notFound" });
    backend.dispose();
  });

  it("needs a signed-in user", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["signed-out"] });
    await expect(ticketFor(backend)).rejects.toMatchObject({ code: "unauthenticated" });
    backend.dispose();
  });
});

describe("mock uploads area: send", () => {
  it("moves the bytes by ticks, reports progress and finishes the upload", async () => {
    const backend = backendOf();
    const events: (Library | null)[] = [];
    backend.on.libraryChanged((library) => events.push(library));
    const ticket = await ticketFor(backend, "clip.mp4", 1000);
    const progress: number[] = [];
    let done = false;
    const sent = backend.uploads
      .send(ticket, new Blob(["x"]), { onProgress: (received) => progress.push(received) })
      .then(() => {
        done = true;
      });
    await settle();
    expect(progress).toEqual([]);
    backend.tick();
    expect(progress).toEqual([200]);
    expect(await backend.uploads.state(ticket.id)).toEqual({
      received: 200,
      size: 1000,
      done: false,
    });
    for (let n = 1; n < UPLOAD_TICKS; n += 1) backend.tick();
    await sent;
    expect(done).toBe(true);
    expect(progress.at(-1)).toBe(1000);
    expect(await backend.uploads.state(ticket.id)).toMatchObject({ received: 1000, done: true });
    const video = (await backend.getLibrary()).channels
      .flatMap((c) => c.videos)
      .find((v) => v.id === NIGHT_CREAM);
    expect(video?.uploading).toBe(false);
    expect(events.length).toBeGreaterThan(1);
    backend.dispose();
  });

  it("pauses by abort and continues from what the server has", async () => {
    const backend = backendOf();
    const ticket = await ticketFor(backend, "clip.mp4", 1000);
    const controller = new AbortController();
    const first = backend.uploads.send(ticket, new Blob(["x"]), { signal: controller.signal });
    const failed = first.catch((error: unknown) => error);
    await settle();
    backend.tick();
    backend.tick();
    controller.abort();
    expect(isAbortError(await failed)).toBe(true);
    expect((await backend.uploads.state(ticket.id)).received).toBe(400);
    backend.tick();
    expect((await backend.uploads.state(ticket.id)).received).toBe(400);

    const seen: number[] = [];
    const second = backend.uploads.send(ticket, new Blob(["x"]), {
      onProgress: (received) => seen.push(received),
    });
    await settle();
    for (let n = 0; n < 3; n += 1) backend.tick();
    await second;
    expect(seen).toEqual([600, 800, 1000]);
    backend.dispose();
  });

  it("refuses a second writer of one upload", async () => {
    const backend = backendOf();
    const ticket = await ticketFor(backend);
    void backend.uploads.send(ticket, new Blob(["x"]));
    await settle();
    await expect(backend.uploads.send(ticket, new Blob(["x"]))).rejects.toMatchObject({
      code: "conflict",
    });
    backend.dispose();
  });

  it("fails with notFound when the upload is cancelled meanwhile", async () => {
    const backend = backendOf();
    const ticket = await ticketFor(backend);
    const sent = backend.uploads.send(ticket, new Blob(["x"])).catch((error: unknown) => error);
    await settle();
    backend.tick();
    await backend.cancelUpload({ id: ticket.id });
    backend.tick();
    expect(await sent).toMatchObject({ code: "notFound" });
    backend.dispose();
  });

  it("resolves at once for a finished upload", async () => {
    const backend = backendOf();
    const ticket = await ticketFor(backend);
    const sent = backend.uploads.send(ticket, new Blob(["x"]));
    await settle();
    for (let n = 0; n < UPLOAD_TICKS; n += 1) backend.tick();
    await sent;
    await expect(backend.uploads.send(ticket, new Blob(["x"]))).resolves.toBeUndefined();
    backend.dispose();
  });
});

describe("mock uploads area: cancelUpload and state", () => {
  it("cancelling removes the unfinished upload and the uploading flag", async () => {
    const backend = backendOf();
    const ticket = await ticketFor(backend);
    expect(await backend.cancelUpload({ id: ticket.id })).toBeNull();
    await expect(backend.uploads.state(ticket.id)).rejects.toMatchObject({ code: "notFound" });
    await expect(backend.cancelUpload({ id: ticket.id })).rejects.toMatchObject({
      code: "notFound",
    });
    const video = (await backend.getLibrary()).channels
      .flatMap((c) => c.videos)
      .find((v) => v.id === NIGHT_CREAM);
    expect(video?.uploading).toBe(false);
    // The name is free again.
    await expect(ticketFor(backend)).resolves.toMatchObject({ name: "clip.mp4" });
    backend.dispose();
  });

  it("cancelling never removes a finished file", async () => {
    const backend = backendOf();
    const finished = backend.world.uploads.find((u) => u.done);
    expect(finished).toBeDefined();
    await backend.cancelUpload({ id: finished?.id ?? "" });
    expect(backend.world.uploads.some((u) => u.id === finished?.id)).toBe(true);
    backend.dispose();
  });

  it("the scenario uploading has an unfinished upload with its progress", async () => {
    const backend = backendOf(["uploading"]);
    const pending = backend.world.uploads.find((u) => !u.done);
    expect(pending).toMatchObject({
      userId: ADMIN_ID,
      videoId: NIGHT_CREAM,
      name: "texture-shots.mp4",
    });
    expect(await backend.uploads.state(pending?.id ?? "")).toMatchObject({
      received: 340_000_000,
      done: false,
    });
    const video = (await backend.getLibrary()).channels
      .flatMap((c) => c.videos)
      .find((v) => v.id === NIGHT_CREAM);
    expect(video?.uploading).toBe(true);
    backend.dispose();
  });
});

describe("mock uploads area: two users", () => {
  it("another user's video and upload do not exist for them", async () => {
    const admin = backendOf();
    const user = new MockBackend({
      ...options,
      scenarios: ["default"],
      world: admin.world,
      as: "user",
    });
    await expect(
      user.createUpload({
        target: { kind: "video", videoId: NIGHT_CREAM },
        name: "a.mp4",
        size: 10,
      }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      user.createUpload({ target: channelTarget, name: "a.mp4", size: 10 }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(user.listUploads({ target: channelTarget })).rejects.toMatchObject({
      code: "notFound",
    });
    await expect(
      user.listUploads({ target: { kind: "video", videoId: NIGHT_CREAM } }),
    ).rejects.toMatchObject({ code: "notFound" });
    // Nor does the admin reach the user's channel.
    await expect(
      admin.listUploads({ target: { kind: "channel", channelId: USER_CHANNEL_TRAVEL } }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      user.listUploads({ target: { kind: "channel", channelId: USER_CHANNEL_TRAVEL } }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: "map.png" })]));
    const ticket = await ticketFor(admin);
    await expect(user.uploads.state(ticket.id)).rejects.toMatchObject({ code: "notFound" });
    await expect(user.cancelUpload({ id: ticket.id })).rejects.toMatchObject({ code: "notFound" });
    await expect(user.uploads.send(ticket, new Blob(["x"]))).rejects.toMatchObject({
      code: "notFound",
    });
    // The owner still has it.
    expect((await admin.uploads.state(ticket.id)).received).toBe(0);
    user.dispose();
    admin.dispose();
  });
});

describe("mock uploads area: listUploads and what an upload blocks", () => {
  it("lists the finished files of a video and of a channel in natural order", async () => {
    const backend = backendOf();
    const video = await backend.listUploads({ target: { kind: "video", videoId: HAIR_OIL_ID } });
    expect(video.map((f) => f.name)).toEqual(["background-music.mp3", "logo.png", "script.pdf"]);
    expect(video[0]?.name).toBe("background-music.mp3");
    expect(video[0]?.size).toBeGreaterThan(0);
    expect(video[0]?.modifiedAt).toBeGreaterThan(0);
    const channel = await backend.listUploads({ target: channelTarget });
    expect(channel.map((f) => f.name)).toEqual(["brand-kit.zip", "intro-jingle.wav"]);
    await expect(
      backend.listUploads({ target: { kind: "channel", channelId: ADMIN_CHANNEL_TECH } }),
    ).resolves.toEqual([]);
    backend.dispose();
  });

  it("lists a file once it is complete, not while it is being sent", async () => {
    const backend = backendOf();
    const ticket = await ticketFor(backend, "clip.mp4", 1000);
    const target = { kind: "video", videoId: NIGHT_CREAM } as const;
    expect((await backend.listUploads({ target })).map((f) => f.name)).not.toContain("clip.mp4");
    const sent = backend.uploads.send(ticket, new Blob(["x"]));
    await settle();
    for (let n = 0; n < UPLOAD_TICKS; n += 1) backend.tick();
    await sent;
    expect((await backend.listUploads({ target })).map((f) => f.name)).toEqual([
      "clip.mp4",
      "product-shots.zip",
    ]);
    backend.dispose();
  });

  it("an upload into a video blocks Start Editing of it until it is done", async () => {
    const backend = backendOf();
    const offered = async () =>
      (await backend.getLibrary()).channels
        .flatMap((c) => c.videos)
        .find((v) => v.id === NIGHT_CREAM)?.actions ?? [];
    const startable = (await offered()).includes("startEdit");
    expect(startable).toBe(true);
    const ticket = await ticketFor(backend);
    expect(await offered()).not.toContain("startEdit");
    await backend.cancelUpload({ id: ticket.id });
    expect((await offered()).includes("startEdit")).toBe(startable);
    backend.dispose();
  });

  it("an upload into a channel blocks nothing", async () => {
    const backend = backendOf();
    const actionsOf = async () =>
      (await backend.getLibrary()).channels
        .flatMap((c) => c.videos)
        .map((v) => [v.id, v.actions, v.uploading]);
    const before = await actionsOf();
    await backend.createUpload({ target: channelTarget, name: "big.zip", size: 1000 });
    expect(await actionsOf()).toEqual(before);
    backend.dispose();
  });
});
