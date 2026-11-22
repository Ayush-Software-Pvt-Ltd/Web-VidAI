/**
 * Seed of the workspace area: two channels of the admin and one of the user (the admin made them
 * and gave one to the user; their folders are in `seed/storage.ts`).
 */
import type { ChannelProfile } from "../../types";
import { ADMIN_ID, USER_ID } from "./session";
import type { MockChannel, World } from "../world";
import { BEAUTY_DIR, TECH_DIR, TRAVEL_DIR } from "./storage";

export const ADMIN_CHANNEL_BEAUTY = "c0ffee00000000000000000000000001";
export const ADMIN_CHANNEL_TECH = "c0ffee00000000000000000000000002";
export const USER_CHANNEL_TRAVEL = "c0ffee00000000000000000000000003";

export function profile(kind: string): ChannelProfile {
  const slots = (what: string) =>
    Array.from({ length: 5 }, (_unused, index) => ({
      name: index === 0 ? "Default" : `${what} ${index + 1}`,
      text: index === 0 ? `The ${kind} ${what.toLowerCase()} of this channel.` : "",
    }));
  return { prompts: slots("Prompt"), styles: slots("Style") };
}

/** A channel in the default shape: automatic video type and the profiles of `profile()`. */
export function makeChannel(id: string, userId: string, name: string, dir: string): MockChannel {
  return {
    id,
    userId,
    name,
    dir,
    videoType: "auto",
    long: profile("long"),
    short: profile("short"),
    available: true,
  };
}

export function seedWorkspace(world: World): void {
  world.channels.push(
    makeChannel(ADMIN_CHANNEL_BEAUTY, ADMIN_ID, "Beauty Channel", BEAUTY_DIR),
    makeChannel(ADMIN_CHANNEL_TECH, ADMIN_ID, "Tech Reviews", TECH_DIR),
    makeChannel(USER_CHANNEL_TRAVEL, USER_ID, "Travel Diary", TRAVEL_DIR),
  );
}
