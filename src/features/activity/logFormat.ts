/** Pure helpers for showing and copying the job log. */
import type { JobView, LogEntry, VideoAction } from "@/lib/types";
import { jobAgent } from "@/features/jobs";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** "4:42 PM" or "16:42", following the system locale. */
export function formatLogTime(ts: string): string {
  return timeFormat.format(new Date(ts));
}

export function formatLogTimeFull(ts: string): string {
  return fullTimeFormat.format(new Date(ts));
}

/**
 * Splits a tool line such as "Bash: Render graphics at 1080" into the tool and what it does.
 * Lines without a tool prefix come back with `tool: null`.
 */
export function splitToolLine(text: string): { tool: string | null; rest: string } {
  const match = /^([A-Za-z][\w.-]{0,40}):\s+([\s\S]*)$/.exec(text);
  if (!match?.[1] || match[2] === undefined) return { tool: null, rest: text };
  return { tool: match[1], rest: match[2] };
}

const KIND_PREFIX: Record<LogEntry["kind"], string> = {
  status: "",
  assistant: "Claude: ",
  tool: "",
  toolResult: "-> ",
  user: "You: ",
  error: "Error: ",
};

/** The whole log as plain text, for the clipboard. */
export function logToText(entries: readonly LogEntry[]): string {
  return entries
    .map((entry) => {
      const indent = entry.nested ? "    " : "";
      const time = formatLogTimeFull(entry.ts);
      let line = `${time}  ${indent}${KIND_PREFIX[entry.kind]}${entry.text}`;
      if (entry.detail) {
        const detail = entry.detail
          .split("\n")
          .map((l) => `${indent}      ${l}`)
          .join("\n");
        line += `\n${detail}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * What the user can do about a failed job, in one or two sentences. The server's own sentence
 * (`job.error`) says what went wrong; this says what to press next, from the buttons the server
 * offers (`actions`).
 */
export function failureAdvice(job: JobView, actions: readonly VideoAction[]): string {
  const error = job.error?.toLowerCase() ?? "";
  const canContinue = actions.includes("continue");
  const program = jobAgent(job);
  if (job.kind === "render") {
    return actions.includes("renderFinal")
      ? "Render Final starts the render again from the first frame. The log shows what happened."
      : "The log shows what happened.";
  }
  if (/usage limit|rate limit/.test(error)) {
    return canContinue
      ? `Wait until the limit resets, then press Continue Editing. ${program} picks up in the same session.`
      : "Wait until the limit resets, then try again.";
  }
  if (/not logged in|logged out|login/.test(error)) {
    return canContinue
      ? "Ask your admin to sign the editing program in again, then press Continue Editing."
      : "Ask your admin to sign the editing program in again, then try again.";
  }
  if (canContinue) {
    return "Continue Editing resumes the same session and tells the editing program what was missing. The log shows what happened.";
  }
  if (actions.includes("startEdit")) {
    return "Start Editing begins again. The log shows what happened.";
  }
  return "The log shows what happened.";
}

/** What the user can do next with a stopped job, or `null` when the server offers nothing. */
export function stoppedAdvice(job: JobView, actions: readonly VideoAction[]): string | null {
  if (job.kind === "render") {
    return actions.includes("renderFinal")
      ? "Render Final starts it again from the first frame."
      : null;
  }
  if (actions.includes("continue")) return "Continue Editing picks up where it stopped.";
  if (actions.includes("startEdit")) return "Start Editing begins again.";
  if (actions.includes("reEdit")) return "Re-Edit asks for the changes you still want.";
  return null;
}

/** Within this many pixels of the bottom counts as "at the latest entry". */
const STICK_THRESHOLD_PX = 24;

/** Whether a scroll container shows its end (the log then follows new entries). */
export function isAtBottom(
  el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
}
