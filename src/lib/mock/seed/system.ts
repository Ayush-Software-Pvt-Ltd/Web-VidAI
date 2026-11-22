/**
 * Seed of the system area, the readiness and usage part: the usage of the server's Claude
 * subscription (a moderate 5-hour window, little of the week), the OpenCode Go quota that shows
 * only while the setup is OpenCode Go, and the two patches the scenarios `usage-critical` and
 * `not-ready` apply. The System page's facts are `seed/prepare.ts`.
 */
import type { OpencodeUsage, Readiness, UsageStatus } from "../../types";
import type { World } from "../world";
import { seedPrepare } from "./prepare";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The Claude plan's limits, as the server's Claude Code reports them. */
export function sampleClaudeUsage(now: number, critical = false): UsageStatus {
  return {
    available: true,
    limits: [
      {
        key: "fiveHour",
        label: "5-hour limit",
        usedPercent: critical ? 93 : 21,
        resetsAt: now + 3 * HOUR + 12 * MINUTE,
      },
      {
        key: "weekly",
        label: "Weekly limit",
        usedPercent: critical ? 71 : 33,
        resetsAt: now + 4 * DAY + 2 * HOUR,
      },
      {
        key: "weeklyOpus",
        label: "Weekly limit (Opus)",
        usedPercent: critical ? 64 : 12,
        resetsAt: now + 4 * DAY + 2 * HOUR,
      },
    ],
    fetchedAt: now - 20_000,
    error: null,
  };
}

/** The OpenCode Go quota: a moderate 5-hour window, little of the week and the month. */
export function sampleGoUsage(now: number): OpencodeUsage {
  return {
    limits: [
      { key: "fiveHour", label: "5-hour limit", usedPercent: 34, resetsAt: now + 2.6 * HOUR },
      { key: "weekly", label: "Weekly limit", usedPercent: 12, resetsAt: now + 3.2 * DAY },
      { key: "monthly", label: "Monthly limit", usedPercent: 6, resetsAt: now + 19 * DAY },
    ],
    unavailable: null,
    fetchedAt: now - 20_000,
    error: null,
  };
}

/** What the server says while Claude Code is not logged in (`server/src/agents/readiness.js`). */
export const NOT_READY: Record<"admin" | "user", Readiness> = {
  admin: {
    problem: "claudeLoggedOut",
    message:
      "Claude Code is not logged in on the computer that runs VidAI. Run claude once in a terminal there and sign in.",
  },
  user: {
    problem: "claudeLoggedOut",
    message:
      "Claude Code is not logged in on the computer that runs VidAI. Ask an admin to fix it.",
  },
};

export function seedSystem(world: World, now: number): void {
  world.usage = { claude: sampleClaudeUsage(now), opencode: sampleGoUsage(now) };
  // The programs and Prepare of the System page: `seed/prepare.ts`.
  seedPrepare(world, now);
}

/** Scenario `usage-critical`: the 5-hour limit is above 90 percent, the week above 70. */
export function makeUsageCritical(world: World): void {
  world.usage = { ...world.usage, claude: sampleClaudeUsage(Date.now(), true) };
}

/** Scenario `not-ready`: new edits cannot start, and the admin and the user are told how. */
export function makeNotReady(world: World): void {
  world.readinessAdmin = { ...NOT_READY.admin };
  world.readinessUser = { ...NOT_READY.user };
}
