import { afterEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend";
import { USER_ID } from "../seed/session";
import { FOOTAGE_ROOT } from "../seed/storage";
import { MEDIA_ROOT, personalFolder } from "./workspace";

const options = { latencyMs: 0, autoTick: false } as const;
const backends: MockBackend[] = [];

function make(as: "admin" | "user" = "user") {
  const backend = new MockBackend({ ...options, scenarios: ["default"], as });
  backends.push(backend);
  return backend;
}

afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
});

const link = (dir: string) => ({ kind: "link" as const, dir });

describe("mock workspace area: where a channel may live (server/src/channels.js)", () => {
  it("refuses a folder outside every storage folder with the server's sentence", async () => {
    const backend = make();
    await expect(
      backend.createChannel({ name: "Out", videoType: "auto", location: link("/etc/videos") }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "This folder is outside the storage folders the admin allows.",
    });
  });

  it("refuses a storage folder or a personal folder as the channel itself", async () => {
    const backend = make();
    for (const dir of [FOOTAGE_ROOT, MEDIA_ROOT, personalFolder(USER_ID)]) {
      await expect(
        backend.createChannel({ name: `At ${dir}`, videoType: "auto", location: link(dir) }),
      ).rejects.toMatchObject({
        code: "invalidInput",
        message: "A storage folder cannot be a channel itself. Choose or make a folder inside it.",
      });
    }
  });

  it("refuses a folder inside or around another channel, also another user's", async () => {
    const backend = make();
    const made = await backend.createChannel({
      name: "Outer",
      videoType: "auto",
      location: link(`${FOOTAGE_ROOT}/group/outer`),
    });
    expect(made.dir).toBe(`${FOOTAGE_ROOT}/group/outer`);
    const taken = { code: "conflict", message: "This folder already belongs to a channel." };
    await expect(
      backend.createChannel({
        name: "Inner",
        videoType: "auto",
        location: link(`${FOOTAGE_ROOT}/group/outer/inner`),
      }),
    ).rejects.toMatchObject(taken);

    const admin = new MockBackend({
      ...options,
      scenarios: ["default"],
      as: "admin",
      world: backend.world,
    });
    backends.push(admin);
    await expect(
      admin.createChannel({
        name: "Around",
        videoType: "auto",
        location: link(`${FOOTAGE_ROOT}/group`),
      }),
    ).rejects.toMatchObject(taken);
    await expect(
      admin.createChannel({
        name: "Same",
        videoType: "auto",
        location: link(`${FOOTAGE_ROOT}/group/outer`),
      }),
    ).rejects.toMatchObject(taken);
    // A sibling folder is fine.
    const sibling = await admin.createChannel({
      name: "Sibling",
      videoType: "auto",
      location: link(`${FOOTAGE_ROOT}/group/outer-two`),
    });
    expect(sibling.dir).toBe(`${FOOTAGE_ROOT}/group/outer-two`);
  });
});
