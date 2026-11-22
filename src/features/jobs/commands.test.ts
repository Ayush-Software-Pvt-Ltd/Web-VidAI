import { describe, expect, it } from "vitest";
import type { JobView, VideoView } from "@/lib/types";
import { jobCommands, jobIdOf, videoIdOf, type JobCommands } from "./commands";
import { recordedApp } from "./recordedApp";

/** Never called: `tsc` checks that a job id and a video id cannot be swapped. */
function typeChecks(commands: JobCommands, video: VideoView, job: JobView): void {
  void commands.pause(jobIdOf(job));
  void commands.continue(jobIdOf(job));
  void commands.stop(jobIdOf(job));
  void commands.startNow(jobIdOf(job));
  void commands.startEdit(videoIdOf(video), false);
  void commands.reEdit(videoIdOf(video), "text", false);
  void commands.renderFinal(videoIdOf(video), 1080);
  // @ts-expect-error a video id is not a job id
  void commands.pause(video.id);
  // @ts-expect-error a video id is not a job id
  void commands.stop(videoIdOf(video));
  // @ts-expect-error a job id is not a video id
  void commands.startEdit(jobIdOf(job), false);
  // @ts-expect-error a job id is not a video id
  void commands.renderFinal(jobIdOf(job), 1080);
  // @ts-expect-error a plain string is neither
  void commands.continue(job.id);
}

describe("job commands", () => {
  it("keep job ids and video ids apart in the types", () => {
    expect(typeChecks).toBeTypeOf("function");
  });

  it("send the id each command is about: jobs by job id, videos by video id", async () => {
    const env = await recordedApp({ scenarios: ["busy"] });
    const commands = jobCommands(env.store);
    const running = env.video("Serum A");
    const job = running.job;
    if (!job) throw new Error("seed changed");
    expect(job.id).not.toBe(running.id);
    await commands.pause(jobIdOf(job));
    expect(env.calls("pauseJob")).toEqual([{ jobId: job.id }]);
    await commands.startEdit(videoIdOf(env.video("Serum F")), false).catch(() => undefined);
    expect(env.calls("startEdit")).toEqual([{ videoId: env.video("Serum F").id, urgent: false }]);
  });

  it("put the answer into the library", async () => {
    const env = await recordedApp();
    const commands = jobCommands(env.store);
    const video = env.video("Hair Oil");
    const job = await commands.startEdit(videoIdOf(video), false);
    expect(env.video("Hair Oil").job?.id).toBe(job.id);
  });
});
