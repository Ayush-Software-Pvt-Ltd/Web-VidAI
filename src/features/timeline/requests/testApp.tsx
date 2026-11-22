/**
 * Test support of the requests folder: an app with an open timeline (the mock's `timeline` and
 * `timeline-notes` scenarios) and a playback store whose driver records what the components ask
 * of the player.
 */
import { act } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { ScenarioName } from "@/lib/mock";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { createPlaybackStore, type PlaybackDriver, type PlaybackStore } from "../playback";
import { KeyOwner } from "./KeyOwner";

export interface RequestsApp extends TestApp {
  playback: PlaybackStore;
  /** What the components asked of the player, oldest first. */
  driver: { seeks: number[]; plays: number; pauses: number };
  videoId: string;
  /** Renders `ui` inside the playback context of the open timeline. */
  mount: (ui: ReactElement) => ReturnType<TestApp["render"]>;
}

export async function requestsApp(
  videoId: string,
  scenarios: ScenarioName[] = ["timeline", "timeline-notes"],
  options: SetupOptions & { frame?: number } = {},
): Promise<RequestsApp> {
  const { frame = 0, ...setup } = options;
  const app = await setupApp(scenarios, setup);
  await act(async () => {
    await app.store.getState().openTimelineOf(videoId);
  });
  await vi.waitFor(() => {
    if (app.store.getState().timelines[videoId]?.timeline.status !== "ready") {
      throw new Error("the timeline is not open");
    }
  });
  const driver = { seeks: [] as number[], plays: 0, pauses: 0 };
  const recording: PlaybackDriver = {
    seek: (to) => driver.seeks.push(to),
    play: () => {
      driver.plays += 1;
    },
    pause: () => {
      driver.pauses += 1;
    },
  };
  const playback = createPlaybackStore(recording, { frame, playing: false, ready: true });
  return {
    ...app,
    playback,
    driver,
    videoId,
    mount: (ui) => app.render(<KeyOwner playback={playback}>{ui}</KeyOwner>),
  };
}

/** The value, or a failed test when there is none (tests avoid `!`). */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected a ${what}`);
  return value;
}

/** The change requests of the open timeline. */
export function notesOf(app: RequestsApp) {
  return must(app.store.getState().timelines[app.videoId]?.timeline.data, "timeline").notes;
}
