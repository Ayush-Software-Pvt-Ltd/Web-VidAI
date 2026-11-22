/**
 * The scenario `admin-channels`: several users with channels all over the server, to review the
 * admin's Channels page. Besides the two seeded accounts there are Ana and Ben; Ana's "Cooking
 * Basics" is busy (an edit runs, so its owner and folder are locked) and Ben's "Retro Games" lies
 * on the network volume that cannot be reached (it shows as unavailable).
 */
import type { World } from "../world";
import { addUser } from "./admin";
import { addJob } from "./jobs";
import { makeVideo } from "./library";
import { HOME, OFFLINE_VOLUME, SSD } from "./storage";
import { makeChannel } from "./workspace";

export const ANA_EMAIL = "ana@example.com";
export const BEN_EMAIL = "ben@example.com";
export const COOKING_ID = "c0ffee00000000000000000000000004";
export const GARDEN_ID = "c0ffee00000000000000000000000005";
export const RETRO_ID = "c0ffee00000000000000000000000006";
export const CHESS_ID = "c0ffee00000000000000000000000007";
export const COOKING_DIR = `${SSD}/Cooking Basics`;
export const GARDEN_DIR = `${HOME}/Footage/Garden Weekly`;
export const RETRO_DIR = `${OFFLINE_VOLUME}/Retro Games`;
export const CHESS_DIR = `${SSD}/Client Shoots/Chess Club`;

export function addAdminChannelsScenario(world: World, now: number): void {
  const ana = addUser(world, { email: ANA_EMAIL }, now);
  const ben = addUser(world, { email: BEN_EMAIL }, now);
  const channels = [
    makeChannel(COOKING_ID, ana.id, "Cooking Basics", COOKING_DIR),
    makeChannel(GARDEN_ID, ana.id, "Garden Weekly", GARDEN_DIR),
    makeChannel(RETRO_ID, ben.id, "Retro Games", RETRO_DIR),
    makeChannel(CHESS_ID, ben.id, "Chess Club", CHESS_DIR),
  ];
  const retro = channels[2];
  if (retro) retro.available = false;
  world.channels.push(...channels);

  const video = (channelId: string, userId: string, folderName: string, daysAgo: number) =>
    world.videos.push(makeVideo({ channelId, userId, folderName, daysAgo }, now));
  video(COOKING_ID, ana.id, "Knife Skills", 2);
  video(COOKING_ID, ana.id, "Sourdough Starter", 6);
  video(COOKING_ID, ana.id, "Weeknight Pasta", 9);
  video(GARDEN_ID, ana.id, "Spring Planting", 4);
  video(RETRO_ID, ben.id, "Arcade Tour", 12);
  video(CHESS_ID, ben.id, "Opening Traps", 3);
  video(CHESS_ID, ben.id, "Endgame Basics", 8);

  addJob(
    world,
    {
      channelId: COOKING_ID,
      folderName: "Knife Skills",
      userId: ana.id,
      state: "running",
      steps: 4,
    },
    now,
  );
}
