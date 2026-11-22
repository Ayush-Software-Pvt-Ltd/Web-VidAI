/** Helpers of the library tests: extra videos and rows in the mock world. */
import { makeVideo } from "@/lib/mock/seed/library";
import type { MockBackend } from "@/lib/mock";

/** The first channel of the signed-in-by-default user of the world that has `userId`. */
export function channelOf(backend: MockBackend, userId: string) {
  const channel = backend.world.channels.find((c) => c.userId === userId);
  if (!channel) throw new Error("no channel for the user");
  return channel;
}

/** Adds `count` video folders (`Bulk 0001`, ...) to the first channel of a user. */
export function addVideos(userId: string, count: number): (backend: MockBackend) => void {
  return (backend) => {
    const channel = channelOf(backend, userId);
    for (let n = 0; n < count; n += 1) {
      backend.world.videos.push(
        makeVideo(
          {
            channelId: channel.id,
            userId,
            folderName: `Bulk ${String(n).padStart(4, "0")}`,
            daysAgo: 10 + n / 100,
          },
          Date.now(),
        ),
      );
    }
  };
}

/** The listitem of a row, found by the name of its main button. */
export function rowOf(name: string | RegExp, root: ParentNode = document): HTMLElement {
  const main = [...root.querySelectorAll<HTMLElement>("[data-row-main]")].find((el) =>
    typeof name === "string" ? el.textContent === name : name.test(el.textContent),
  );
  const item = main?.closest<HTMLElement>('[role="listitem"]');
  if (!item) throw new Error(`row ${String(name)} not found`);
  return item;
}
