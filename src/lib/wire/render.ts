// Render Final (SPEC section 12). Pure declarations.

/** The height of the final video: 1080 renders at the project's own size, 2160 at 4K. */
export type RenderResolution = 1080 | 2160;

/**
 * The input of `renderFinal`; the answer is the queued `JobView` (kind `render`). Refused while
 * the video has an active job or change requests that are not applied, when it has no project,
 * when the project has errors, or when the server's disk is too small for the render.
 */
export interface RenderFinalInput {
  /** `<channelId>/<folder name>`. */
  videoId: string;
  resolution: RenderResolution;
}
