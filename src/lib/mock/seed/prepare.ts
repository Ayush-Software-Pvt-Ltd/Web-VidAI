/**
 * Seed of the system area, the System page part: the programs the server found, the steps of
 * Prepare (the ids, labels, what blocks and what each step waits for are those of
 * `server/src/toolkit/steps.js`), a prepared state for the default world, and the patches of the
 * scenarios `system-problems` and `system-prepare-fails`. The Prepare run itself is
 * `areas/prepare.ts`; this file also holds its switches (`prepareSim`).
 */
import type {
  PrepareBlocks,
  PrepareState,
  PrepareStep,
  PrepareStepId,
  ProgramInfo,
} from "../../types";
import type { World } from "../world";
import { syncHarness } from "./harness";

const MINUTE = 60_000;

export interface StepDefinition {
  id: PrepareStepId;
  label: string;
  blocks: PrepareBlocks;
  needs: readonly PrepareStepId[];
}

export const STEPS: readonly StepDefinition[] = [
  { id: "python", label: "Python", blocks: "editing", needs: [] },
  { id: "venv", label: "Python environment", blocks: "editing", needs: ["python"] },
  { id: "packages", label: "Python packages", blocks: "editing", needs: ["venv"] },
  { id: "ffmpeg", label: "ffmpeg and ffprobe", blocks: "editing", needs: [] },
  { id: "doctor", label: "Toolkit check", blocks: "editing", needs: ["packages", "ffmpeg"] },
  { id: "speech", label: "Speech model", blocks: "editing", needs: ["packages"] },
  { id: "browser", label: "Renderer browser", blocks: "rendering", needs: [] },
  { id: "render", label: "Test render", blocks: "rendering", needs: ["browser", "ffmpeg"] },
];

/** What each step says when it succeeds (the sentences of the server's steps). */
export const DONE_MESSAGES: Record<PrepareStepId, string> = {
  python: "Python 3.12 at /usr/bin/python3.12",
  venv: "Environment created (Python 3.12, pip 24.0).",
  packages: "Python packages installed.",
  ffmpeg: "ffmpeg at /usr/local/bin/ffmpeg, ffprobe at /usr/local/bin/ffprobe",
  doctor: "The toolkit check passed.",
  speech: "Speech model large-v3 is ready (mlx).",
  browser: "The renderer browser is installed.",
  render: "The test render finished.",
};

/** What each step says when it fails (the first lines of the server's failures). */
export const FAILED_MESSAGES: Record<PrepareStepId, string> = {
  python:
    "No Python 3.10 to 3.13 was found. Install Python 3.12 from https://www.python.org/downloads/ and press Prepare.",
  venv: "The Python environment could not be created. The data folder may be read-only.",
  packages:
    "Installing the Python packages failed. Is the internet reachable? pip said: Could not find a version that satisfies the requirement.",
  ffmpeg: "ffmpeg was not found. Install it and press Prepare.",
  doctor: "The toolkit check failed: the speech package could not be imported.",
  speech: "The speech model could not be downloaded. Is the internet reachable?",
  browser: "The renderer browser could not be installed.",
  render: "The test render failed: the browser did not start.",
};

/** What Prepare does in the mock (switches for tests and scenarios, kept per world). */
export interface PrepareSim {
  /** The step that fails when Prepare runs (the steps that need it wait). */
  failStep: PrepareStepId | null;
  /** The sentence of the failing step; `null` is the default one of `FAILED_MESSAGES`. */
  failMessage: string | null;
  /** The index in `STEPS` of the step that runs now; `null` while no Prepare runs. */
  current: number | null;
}

const sims = new WeakMap<World, PrepareSim>();

export function prepareSim(world: World): PrepareSim {
  let sim = sims.get(world);
  if (sim === undefined) {
    sim = { failStep: null, failMessage: null, current: null };
    sims.set(world, sim);
  }
  return sim;
}

/** The programs of a server where everything is installed. */
export function foundPrograms(): ProgramInfo[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      found: true,
      path: "/usr/local/bin/claude",
      version: "2.4.1",
      note: null,
    },
    {
      id: "opencode",
      label: "OpenCode 2",
      found: true,
      path: "/home/vidai/.opencode/bin/opencode2",
      version: "2.0.0",
      note: null,
    },
    {
      id: "hyperframes",
      label: "HyperFrames",
      found: true,
      path: "/var/lib/vidai/toolkit/node_modules/.bin/hyperframes",
      version: "0.9.2",
      note: null,
    },
    {
      id: "ffmpeg",
      label: "ffmpeg",
      found: true,
      path: "/usr/local/bin/ffmpeg",
      version: "7.1.1",
      note: "Hardware encoders found: nvenc.",
    },
    {
      id: "ffprobe",
      label: "ffprobe",
      found: true,
      path: "/usr/local/bin/ffprobe",
      version: "7.1.1",
      note: null,
    },
    {
      id: "python",
      label: "Python",
      found: true,
      path: "/var/lib/vidai/toolkit/venv/bin/python",
      version: "3.12.4",
      note: "The toolkit's environment.",
    },
  ];
}

function step(def: StepDefinition, patch: Partial<PrepareStep> = {}): PrepareStep {
  return {
    id: def.id,
    label: def.label,
    state: "pending",
    message: null,
    at: null,
    blocks: def.blocks,
    ...patch,
  };
}

/** Prepare done a while ago: every step done, edits and renders may start. */
export function preparedState(now: number): PrepareState {
  const started = now - 90 * MINUTE;
  return {
    running: false,
    steps: STEPS.map((def, index) =>
      step(def, {
        state: "done",
        message: DONE_MESSAGES[def.id],
        at: started + (index + 1) * 12_000,
      }),
    ),
    log: STEPS.flatMap((def) => [`== ${def.label} ==`, `ok: ${DONE_MESSAGES[def.id]}`]),
    startedAt: started,
    finishedAt: started + STEPS.length * 12_000,
    needsPrepare: false,
    reason: null,
    editReady: true,
    renderReady: true,
  };
}

/** A new server: nothing was prepared yet. */
export function unpreparedState(): PrepareState {
  return {
    running: false,
    steps: STEPS.map((def) => step(def)),
    log: [],
    startedAt: null,
    finishedAt: null,
    needsPrepare: true,
    reason: "The Python environment has not been created yet.",
    editReady: false,
    renderReady: false,
  };
}

export function seedPrepare(world: World, now: number): void {
  world.system.programs = foundPrograms();
  world.system.prepare = preparedState(now);
}

/** Scenario `system-problems`: programs missing and Prepare needed (edits cannot start yet). */
export function makeSystemProblems(world: World): void {
  world.system.programs = world.system.programs.map((program) => {
    switch (program.id) {
      case "ffmpeg":
        return {
          ...program,
          found: false,
          path: null,
          version: null,
          note: "ffmpeg was not found. Install it and press Prepare.",
        };
      case "ffprobe":
        return {
          ...program,
          found: false,
          path: null,
          version: null,
          note: "ffprobe was not found. It comes with ffmpeg.",
        };
      case "python":
        return {
          ...program,
          found: false,
          path: null,
          version: null,
          note: "Python 3.10 to 3.13 was not found. Install Python 3.12 from https://www.python.org/downloads/.",
        };
      case "opencode":
        return {
          ...program,
          found: false,
          path: null,
          version: null,
          note: "OpenCode 2 was not found. Install it with curl -fsSL https://opencode.ai/v2/install | bash.",
        };
      default:
        return program;
    }
  });
  world.system.toolkit = { ...world.system.toolkit, installedVersion: "1", upToDate: true };
  world.system.prepare = unpreparedState();
  syncHarness(world);
}

/** Scenario `system-gpu-problem`: an NVIDIA GPU that speech recognition and ffmpeg cannot use yet. */
export function makeGpuProblem(world: World): void {
  const card = "NVIDIA GeForce RTX 5060 Ti";
  world.system.hardware = {
    nvidia: card,
    speech: {
      using: "gpu",
      summary: `GPU (CUDA) (${card}), not usable yet`,
      problem:
        "these CUDA libraries were not found: cublas64_12.dll, cudnn64_9.dll. Press Prepare to install what is missing.",
    },
    video: {
      using: "cpu",
      summary: "libx264 and libx265 (software), decoding in software",
      problem: `${card} is installed but ffmpeg could not start h264_nvenc: Driver does not support the required nvenc API version. Update the NVIDIA driver or use an ffmpeg build that matches it.`,
    },
  };
}

/** Scenario `system-gpu`: an NVIDIA GPU used for speech and video. */
export function makeGpuWorks(world: World): void {
  const card = "NVIDIA GeForce RTX 5060 Ti";
  world.system.hardware = {
    nvidia: card,
    speech: { using: "gpu", summary: `GPU (CUDA) (${card})`, problem: null },
    video: {
      using: "gpu",
      summary: "h264_nvenc and hevc_nvenc, decoding with cuda",
      problem: null,
    },
  };
}

/** Scenario `system-prepare-fails`: Prepare is needed and it fails at the package install. */
export function makePrepareFail(world: World): void {
  world.system.prepare = unpreparedState();
  const sim = prepareSim(world);
  sim.failStep = "packages";
  sim.failMessage = null;
  syncHarness(world);
}
