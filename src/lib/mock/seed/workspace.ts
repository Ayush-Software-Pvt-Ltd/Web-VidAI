/** Seed of the workspace area: two channels of the admin and one of the user. */
import type { ChannelProfile } from "../../types";
import { ADMIN_ID, USER_ID } from "./session";
import type { World } from "../world";

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

export function seedWorkspace(world: World): void {
  const channel = (id: string, userId: string, name: string, dir: string) => ({
    id,
    userId,
    name,
    dir,
    videoType: "auto" as const,
    long: profile("long"),
    short: profile("short"),
    available: true,
  });
  world.channels.push(
    channel(
      ADMIN_CHANNEL_BEAUTY,
      ADMIN_ID,
      "Beauty Channel",
      `/var/lib/vidai/media/${ADMIN_ID}/Beauty Channel`,
    ),
    channel(
      ADMIN_CHANNEL_TECH,
      ADMIN_ID,
      "Tech Reviews",
      `/var/lib/vidai/media/${ADMIN_ID}/Tech Reviews`,
    ),
    channel(
      USER_CHANNEL_TRAVEL,
      USER_ID,
      "Travel Diary",
      `/var/lib/vidai/media/${USER_ID}/Travel Diary`,
    ),
  );
}
