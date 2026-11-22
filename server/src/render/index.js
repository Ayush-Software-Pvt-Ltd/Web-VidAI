// The render module (docs/SPEC.md section 12): the runner for `render` jobs, the `renderFinal`
// function and the helpers Prepare calls. `createRenderModule(deps)` is plugged into the
// composition root like the timeline module.
//
// How the composition root (`engine.js`) wires it:
//   const render = createRenderModule({ dataDir, clock, log, limits: limits.api, registry, sink,
//     library: library.api, timeline: timeline.api, activeJob: jobs.api.activeJobOf,
//     enqueue: queues.enqueue });
//   rpc.register(render.rpc);
//   await render.runner.sweep();            // at start, before any job runs
//   // the job manager calls render.runner.run(job, facts) for `render` jobs;
//   // the installer calls render.prepare.ensureBrowser() and render.prepare.testRender().

import { createRenderRunner } from "./runner.js";
import { createPrepare } from "./prepare.js";
import { createGpuPreference } from "../platform/gpuPreference.js";
import { renderFunctions } from "../rpc/render.js";
import { freeBytes as systemFreeBytes } from "../platform/disk.js";
import { findFfmpeg, findFfprobe } from "../platform/tools.js";
import { dataPaths } from "../config.js";
import { findHyperframesCli } from "../timeline/lint.js";

/**
 * @typedef {object} RenderModuleDeps
 * @property {string} dataDir
 * @property {{ now(): number }} clock
 * @property {import("../log.js").Logger} log
 * @property {import("./runner.js").RenderLimits} limits `limits.api`
 * @property {import("./runner.js").RenderRunnerDeps["registry"]} [registry]
 * @property {import("./runner.js").RenderRunnerDeps["sink"]} sink
 * @property {import("./runner.js").RenderRunnerDeps["onUpdate"]} [onUpdate]
 * @property {import("../rpc/render.js").RenderRpcDeps["library"]} library
 * @property {import("../rpc/render.js").RenderRpcDeps["timeline"]} timeline
 * @property {import("../rpc/render.js").RenderRpcDeps["activeJob"]} activeJob
 * @property {import("../rpc/render.js").RenderRpcDeps["enqueue"]} enqueue
 * @property {import("../rpc/render.js").RenderRpcDeps["renderReady"]} [renderReady] `toolkit.api.renderReady`.
 * @property {string} [hyperframesBin] Default: the installed package's (`findHyperframesCli`: resolved from the package, never from the working directory).
 * @property {import("./runner.js").PathSource} [ffmpeg] Default: found on every use.
 * @property {import("./runner.js").PathSource} [ffprobe]
 * @property {import("./runner.js").PathSource} [browserPath] Default: the browser `prepare.ensureBrowser` found
 *   (`prepare.browserPath()`), else the renderer looks for its own.
 * @property {ReturnType<typeof createGpuPreference>} [gpuPreference] Default: the Windows graphics preference of the browser (a test seam).
 * @property {(dir: string) => Promise<number>} [freeBytes]
 * @property {Partial<import("./runner.js").RenderRunnerDeps>} [runnerOptions] Test seams.
 */

/** @param {RenderModuleDeps} deps */
export function createRenderModule(deps) {
  const hyperframesBin = deps.hyperframesBin ?? findHyperframesCli();
  if (hyperframesBin === null) throw new Error("the hyperframes package is not installed");
  const freeBytes = deps.freeBytes ?? systemFreeBytes;
  const ffmpeg = deps.ffmpeg ?? (() => findFfmpeg());
  const ffprobe = deps.ffprobe ?? (() => findFfprobe());
  const gpuPreference = deps.gpuPreference ?? createGpuPreference({ log: deps.log });
  const prepare = createPrepare({
    hyperframesBin,
    gpuPreference,
    dataDir: deps.dataDir,
    log: deps.log,
    ffmpeg: () => (typeof ffmpeg === "function" ? ffmpeg() : ffmpeg),
    ffprobe: () => (typeof ffprobe === "function" ? ffprobe() : ffprobe),
    ...(deps.browserPath === undefined
      ? {}
      : {
          browserPath: () =>
            typeof deps.browserPath === "function"
              ? deps.browserPath()
              : (deps.browserPath ?? null),
        }),
  });
  const runner = createRenderRunner({
    limits: deps.limits,
    registry: deps.registry ?? null,
    sink: deps.sink,
    ...(deps.onUpdate ? { onUpdate: deps.onUpdate } : {}),
    dataDir: deps.dataDir,
    clock: deps.clock,
    log: deps.log,
    hyperframesBin,
    ffmpeg,
    ffprobe,
    browserPath: deps.browserPath ?? (() => prepare.browserPath()),
    freeBytes,
    ...deps.runnerOptions,
  });
  return {
    name: "render",
    rpc: renderFunctions({
      library: deps.library,
      timeline: deps.timeline,
      activeJob: deps.activeJob,
      enqueue: deps.enqueue,
      renderCacheDir: dataPaths(deps.dataDir).renderCacheDir,
      freeBytes,
      ...(deps.renderReady ? { renderReady: deps.renderReady } : {}),
    }),
    runner,
    prepare,
    gpuPreference,
  };
}

/** @typedef {ReturnType<typeof createRenderModule>} RenderModule */
