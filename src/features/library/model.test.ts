import { describe, expect, it } from "vitest";
import type { JobState, Library, VideoView } from "@/lib/types";
import { UPLOADING_STATUS, rowStatus, unavailableText } from "./presentation";
import {
  buildListModel,
  channelCounts,
  filterBucket,
  jobSummary,
  matchesSearch,
  searchTerms,
  DEFAULT_SORT,
  nextSort,
  sortVideos,
  toEditCount,
} from "./model";
import {
  autoType,
  autoTypeHint,
  effortLabel,
  rowDetail,
  typeInfo,
  usageShortLabel,
} from "./presentation";
import { videoStatus } from "@/lib/status";

const NOW = Date.UTC(2026, 10, 14, 10);

function video(folderName: string, extra: Partial<VideoView> = {}): VideoView {
  return {
    id: `c/${folderName}`,
    channelId: "c",
    folderName,
    createdAt: Date.UTC(2026, 10, 1, 10),
    detectedType: "long",
    typeOverride: null,
    channelType: "auto",
    videoType: "long",
    typeSource: "detected",
    arollCount: 1,
    output: {
      project: null,
      finals: [],
      newestFinal: null,
      thumbnails: [],
      metaFile: null,
      infoFile: null,
    },
    edited: false,
    finalRendered: false,
    uploading: false,
    job: null,
    actions: ["startEdit"],
    ...extra,
  };
}

function withJob(
  v: VideoView,
  state: JobState,
  extra: Partial<NonNullable<VideoView["job"]>> = {},
): VideoView {
  return {
    ...v,
    job: {
      id: "j",
      videoId: v.id,
      userId: "u",
      kind: "edit",
      queue: "edits",
      state,
      urgent: false,
      position: null,
      joinedAt: NOW,
      startedAt: null,
      endedAt: null,
      activeMs: 0,
      runningSince: null,
      startsAt: null,
      lastActivity: null,
      error: null,
      progress: null,
      videoType: "long",
      setup: "claudeSubscription",
      harness: null,
      model: null,
      effort: null,
      costUsd: null,
      ...extra,
    },
  };
}

function library(channels: { id: string; videos: VideoView[]; available?: boolean }[]): Library {
  return {
    channels: channels.map((c) => ({
      channelId: c.id,
      available: c.available ?? true,
      videos: c.videos,
    })),
  };
}

describe("filter buckets", () => {
  it("puts active jobs in progress, then edited or to edit", () => {
    expect(filterBucket(video("a"))).toBe("toEdit");
    expect(filterBucket({ ...video("a"), edited: true })).toBe("edited");
    for (const state of ["queued", "running", "pausing", "paused", "stopping"] as const) {
      expect(filterBucket(withJob({ ...video("a"), edited: true }, state))).toBe("inProgress");
    }
    expect(filterBucket(withJob(video("a"), "failed"))).toBe("toEdit");
    expect(filterBucket(withJob({ ...video("a"), edited: true }, "completed"))).toBe("edited");
    expect(filterBucket({ ...video("a"), finalRendered: true })).toBe("edited");
  });

  it("counts the videos still to edit", () => {
    const videos = [video("a"), withJob(video("b"), "running"), { ...video("c"), edited: true }];
    expect(toEditCount({ videos })).toBe(1);
  });
});

describe("channel counts", () => {
  it("partitions the videos and reports failed ones on top", () => {
    const edited = { ...video("e"), edited: true };
    const rendered = { ...video("r"), edited: true, finalRendered: true };
    const videos = [
      video("n1"),
      withJob(video("n2"), "stopped"),
      withJob(video("f1"), "failed"),
      withJob(edited, "failed"),
      withJob(video("q"), "queued"),
      withJob(edited, "running", { kind: "reEdit" }),
      withJob(video("p"), "paused"),
      edited,
      rendered,
      withJob(rendered, "completed"),
    ];
    expect(channelCounts(videos)).toEqual({ notEdited: 3, editing: 3, edited: 4, failed: 2 });
    expect(channelCounts([])).toEqual({ notEdited: 0, editing: 0, edited: 0, failed: 0 });
  });
});

describe("search", () => {
  it("matches every word, case-insensitively, including Devanagari", () => {
    const hair = video("018 Hair Oil जो आपके बालों की Growth बड़ायेगा");
    expect(matchesSearch(hair, searchTerms("hair growth"))).toBe(true);
    expect(matchesSearch(hair, searchTerms("  बालों  "))).toBe(true);
    expect(matchesSearch(hair, searchTerms("hair shampoo"))).toBe(false);
    expect(matchesSearch(hair, searchTerms(""))).toBe(true);
  });
});

const at = (day: number) => Date.UTC(2026, 10, day, 10);
const names = (videos: readonly VideoView[]) => videos.map((v) => v.folderName);

describe("sorting", () => {
  const videos = [
    video("2 two", { createdAt: at(3) }),
    video("10 ten", { createdAt: at(1) }),
    video("1 one", { createdAt: at(2) }),
  ];

  it("sorts by name in natural order, A-Z then Z-A", () => {
    expect(names(sortVideos(videos, { key: "name", dir: "asc" }))).toEqual([
      "1 one",
      "2 two",
      "10 ten",
    ]);
    expect(names(sortVideos(videos, { key: "name", dir: "desc" }))).toEqual([
      "10 ten",
      "2 two",
      "1 one",
    ]);
  });

  it("sorts by the real folder age, not the name", () => {
    expect(names(sortVideos(videos, { key: "age", dir: "desc" }))).toEqual([
      "2 two",
      "1 one",
      "10 ten",
    ]);
    expect(names(sortVideos(videos, { key: "age", dir: "asc" }))).toEqual([
      "10 ten",
      "1 one",
      "2 two",
    ]);
  });

  it("sorts by status, newest first among equals", () => {
    const mixed = [
      video("edited old", { createdAt: at(1), edited: true }),
      video("todo old", { createdAt: at(1) }),
      video("todo new", { createdAt: at(2) }),
      withJob(video("running", { createdAt: at(1) }), "running"),
      withJob(video("failed", { createdAt: at(1) }), "failed"),
      video("rendered", { createdAt: at(1), edited: true, finalRendered: true }),
    ];
    const asc = ["failed", "todo new", "todo old", "running", "edited old", "rendered"];
    expect(names(sortVideos(mixed, { key: "status", dir: "asc" }))).toEqual(asc);
    expect(names(sortVideos(mixed, { key: "status", dir: "desc" }))).toEqual([
      "rendered",
      "edited old",
      "running",
      "todo new",
      "todo old",
      "failed",
    ]);
  });

  it("starts each key in its first direction and flips the active one", () => {
    expect(DEFAULT_SORT).toEqual({ key: "age", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "name", dir: "desc" }, "age")).toEqual({ key: "age", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "age")).toEqual({ key: "age", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "status")).toEqual({ key: "status", dir: "asc" });
  });
});

describe("list model", () => {
  const channels = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
    { id: "m", name: "Missing" },
  ];
  const lib = library([
    {
      id: "a",
      videos: [video("2 two", { id: "a/2", channelId: "a", createdAt: at(5) })],
    },
    {
      id: "b",
      videos: [
        video("1 one", { id: "b/1", channelId: "b", createdAt: at(9) }),
        video("3 three", { id: "b/3", channelId: "b", createdAt: at(1), edited: true }),
      ],
    },
    { id: "m", videos: [], available: false },
  ]);
  const all = { channels, channelId: null, query: "", filter: "all" } as const;

  it("shows All Channels as one flat list sorted together", () => {
    const model = buildListModel(lib, all);
    expect(model.showChannel).toBe(true);
    expect(names(model.videos)).toEqual(["1 one", "2 two", "3 three"]);
    expect(model.channelNames.get("b")).toBe("Beta");
    expect(model.total).toBe(3);
    const byName = buildListModel(lib, { ...all, sort: { key: "name", dir: "desc" } });
    expect(names(byName.videos)).toEqual(["3 three", "2 two", "1 one"]);
  });

  it("searches and filters across the whole flat list", () => {
    const found = buildListModel(lib, { ...all, query: "t" });
    expect(names(found.videos)).toEqual(["2 two", "3 three"]);
    expect(found.total).toBe(3);
    const edited = buildListModel(lib, { ...all, filter: "edited" });
    expect(names(edited.videos)).toEqual(["3 three"]);
  });

  it("shows one channel without channel names", () => {
    const model = buildListModel(lib, { ...all, channelId: "b", filter: "toEdit" });
    expect(model.showChannel).toBe(false);
    expect(names(model.videos)).toEqual(["1 one"]);
    expect(model.total).toBe(2);
  });

  it("names only the channels in scope", () => {
    expect(buildListModel(lib, { ...all, channelId: "b" }).scopeNames).toEqual(["Beta"]);
    expect(buildListModel(lib, all).scopeNames).toEqual(channels.map((c) => c.name));
  });

  it("only lists the channels it is given (a user sees their own)", () => {
    const own = buildListModel(lib, { ...all, channels: [{ id: "a", name: "Alpha" }] });
    expect(names(own.videos)).toEqual(["2 two"]);
  });
});

describe("labels", () => {
  it("summarizes jobs", () => {
    expect(jobSummary({ running: 2, waiting: 1 })).toBe("2 running, 1 waiting");
    expect(jobSummary({ running: 0, waiting: 3 })).toBe("3 waiting");
    expect(jobSummary({ running: 0, waiting: 0 })).toBeNull();
  });

  it("names effort levels and usage limits", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("turbo")).toBe("Turbo");
    expect(
      usageShortLabel({
        key: "weeklyOpus",
        label: "Weekly limit (Opus)",
        usedPercent: 1,
        resetsAt: null,
      }),
    ).toBe("Opus");
  });

  it("says Uploading for a video whose files are still arriving", () => {
    expect(rowStatus(video("u", { uploading: true }))).toEqual(UPLOADING_STATUS);
    expect(rowStatus(video("u")).label).toBe("Not edited");
    // A job wins: its own status is shown.
    expect(rowStatus(withJob(video("u", { uploading: true }), "queued")).label).toBe("Queued");
  });

  it("words the unreachable folder with the channel name", () => {
    expect(unavailableText("Travel")).toContain('"Travel"');
  });
});

describe("type info", () => {
  // The backend resolves `videoType` and `typeSource`; these fixtures mirror what it sends.
  const detected = video("d", { detectedType: "long" });
  const manual = video("m", { typeOverride: "short", videoType: "short", typeSource: "override" });
  const guess = video("g", { detectedType: null, typeSource: "assumed" });
  const byChannel = video("c", { channelType: "short", videoType: "short", typeSource: "channel" });

  it("shows where the type comes from", () => {
    expect(typeInfo(detected)).toMatchObject({
      type: "long",
      source: "detected",
      note: "Detected from the A-roll.",
      auto: { type: "long", source: "detected" },
    });
    expect(typeInfo(manual)).toMatchObject({
      type: "short",
      source: "override",
      override: "short",
      note: "Set by you. Detected as Long 16:9.",
    });
    expect(typeInfo(guess)).toMatchObject({
      type: "long",
      source: "assumed",
      note: expect.stringMatching(/^Assumed\./) as unknown,
    });
    expect(typeInfo(byChannel)).toMatchObject({
      type: "short",
      source: "channel",
      override: null,
      note: "Set by the channel: Always Short. Detected as Long 16:9.",
      auto: { type: "short", source: "channel" },
    });
    expect(typeInfo({ ...byChannel, detectedType: null }).note, "no readable A-roll").toBe(
      "Set by the channel: Always Short. No A-roll could be read.",
    );
  });

  it("names the channel setting next to a choice of your own", () => {
    const overridden = {
      ...byChannel,
      typeOverride: "long" as const,
      videoType: "long" as const,
      typeSource: "override" as const,
    };
    expect(typeInfo(overridden).note).toBe("Set by you. The channel is set to Always Short.");
  });

  it("shows a pending choice at once", () => {
    // A type is an override; Auto (null) is what Auto resolves to, and clears the mark.
    expect(typeInfo(detected, "short")).toMatchObject({ type: "short", source: "override" });
    expect(typeInfo(manual, null)).toMatchObject({
      type: "long",
      source: "detected",
      override: null,
    });
    expect(typeInfo({ ...manual, channelType: "short" }, null)).toMatchObject({
      type: "short",
      source: "channel",
    });
    expect(typeInfo({ ...manual, detectedType: null }, null)).toMatchObject({
      type: "long",
      source: "assumed",
    });
  });

  it("words the Auto item of the menu", () => {
    expect(autoTypeHint(autoType(detected))).toBe("Detected: Long 16:9");
    expect(autoTypeHint(autoType(byChannel))).toBe("Channel setting: Short 9:16");
    expect(autoTypeHint(autoType(guess))).toBe("Not detected, assumed Long 16:9");
    expect(autoType({ channelType: "long", detectedType: "short" })).toEqual({
      type: "long",
      source: "channel",
    });
  });
});

describe("row detail", () => {
  it("shows the error of a failed job in danger tone", () => {
    const failed = withJob(video("a"), "failed", { error: "Claude usage limit reached" });
    expect(rowDetail(failed, videoStatus(failed))).toEqual({
      text: "Claude usage limit reached",
      tone: "danger",
    });
  });

  it("does not repeat the pill and explains transient states", () => {
    const pausing = withJob(video("a"), "pausing", { lastActivity: "Pausing" });
    expect(rowDetail(pausing, videoStatus(pausing)).text).toMatch(/Finishing the current step/);
    const running = withJob(video("a"), "running", { lastActivity: "Running ffmpeg" });
    expect(rowDetail(running, videoStatus(running)).text).toBe("Running ffmpeg");
  });

  it("names the newest final of a video, or its project, and warns without A-roll", () => {
    const base = video("a");
    const project = { path: "output/review_v1.fcpxml", modifiedAt: NOW };
    const final = (name: string) => ({
      name,
      path: `output/${name}`,
      size: 1,
      modifiedAt: NOW,
    });
    const rendered = {
      ...base,
      edited: true,
      finalRendered: true,
      output: {
        ...base.output,
        project,
        finals: [final("final_1080p.mp4")],
        newestFinal: "output/final_1080p.mp4",
      },
    };
    expect(rowDetail(rendered, videoStatus(rendered)).text).toMatch(/^final_1080p\.mp4 · /);
    const edited = { ...base, edited: true, output: { ...base.output, project } };
    expect(rowDetail(edited, videoStatus(edited)).text).toMatch(/^Project · /);
    const empty = { ...base, arollCount: 0 };
    expect(rowDetail(empty, videoStatus(empty)).tone).toBe("warning");
    expect(rowDetail(video("u", { uploading: true }), rowStatus(video("u"))).text).toBeNull();
  });
});
