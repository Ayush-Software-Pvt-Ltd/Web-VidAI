// The job log as the browser sees it (docs/SPEC.md section 8; written by `server/src/jobs/log.js`).

/** What a log line is about; decides how the log view draws it. */
export type LogKind = "status" | "assistant" | "tool" | "toolResult" | "user" | "error";

/** One line of a job's log. */
export interface LogEntry {
  /** Position in the log, counted from 1 and never reused. */
  seq: number;
  /** When it happened (ISO 8601, UTC). */
  ts: string;
  kind: LogKind;
  text: string;
  /** More to show when the line is opened (a tool's input or output), or null. */
  detail: string | null;
  /** True for lines of a sub-agent or a background task. */
  nested: boolean;
}

/** A job's log as `getJobLog` returns it, and the payload of the `job-log` event (new lines only). */
export interface JobLog {
  videoId: string;
  jobId: string;
  entries: LogEntry[];
}
