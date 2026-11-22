// How far a job is, as the server reports it (docs/SPEC.md section 8 "Progress"). Pure
// declarations; every field is always present (`null` when empty), nothing is optional.

/** How far a job is: the bar of every video row and of the activity panel. */
export interface JobProgress {
  /** 0 to 100: at most 99 until the job is `completed`, then exactly 100. Never goes backwards. */
  percent: number;
  /** One short user-facing label for the current step, for example "Transcribing". */
  stage: string | null;
  /**
   * Seconds left at this job's pace, rounded to 5 seconds, or `null` when it cannot be told: the
   * job is later than typical, still getting its tools ready, in its last step, completed, or a
   * render (whose stages run at different speeds).
   */
  secondsLeft: number | null;
}
