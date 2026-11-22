/**
 * A world with every field present and nothing in it. Seeds add to it, scenarios patch it. The
 * values that must exist for the server to look sane (settings, harness, system facts) are here.
 */
import type {
  ApiOption,
  ApiOptionState,
  HarnessAdminState,
  PrepareState,
  SystemCounts,
  SystemView,
} from "../../types";
import type { World } from "../world";

const API_URLS: Record<ApiOption, string> = {
  opencodeGo: "https://opencode.ai/inference/go/anthropic",
  anthropicApi: "https://api.anthropic.com",
  openaiApi: "https://opencode.ai/inference/go/v1",
};

function optionState(option: ApiOption): ApiOptionState {
  return {
    baseUrl: null,
    effectiveBaseUrl: API_URLS[option],
    defaultBaseUrl: API_URLS[option],
    keyRequired: option === "opencodeGo",
    key: { saved: false, last4: null },
    model: null,
    efforts: {},
  };
}

export function emptyHarness(): HarnessAdminState {
  return {
    setup: "claudeSubscription",
    program: "claudeCode",
    options: {
      opencodeGo: optionState("opencodeGo"),
      anthropicApi: optionState("anthropicApi"),
      openaiApi: optionState("openaiApi"),
    },
    claude: { model: null, effort: null, models: [] },
    claudeRouting: null,
  };
}

export function emptyPrepare(): PrepareState {
  return {
    running: false,
    steps: [],
    log: [],
    startedAt: null,
    finishedAt: null,
    needsPrepare: false,
    reason: null,
    editReady: true,
    renderReady: true,
  };
}

function emptyCounts(): SystemCounts {
  return {
    users: { total: 0, admins: 0, disabled: 0 },
    channels: 0,
    jobs: {
      queued: 0,
      running: 0,
      pausing: 0,
      paused: 0,
      stopping: 0,
      stopped: 0,
      failed: 0,
      completed: 0,
    },
  };
}

function emptySystem(now: number): SystemView {
  return {
    server: {
      version: "1.0.0",
      node: "v22.0.0",
      os: "linux",
      hostname: "vidai-server",
      startedAt: now,
    },
    dataDir: { path: "/var/lib/vidai", freeBytes: 500e9, totalBytes: 1000e9 },
    addresses: ["https://vidai.example.com:8443"],
    toolkit: {
      installedVersion: "1",
      shippedVersion: "1",
      upToDate: true,
      installError: null,
      folder: "/var/lib/vidai/toolkit",
      python: "/var/lib/vidai/toolkit/venv/bin/python",
      hasPrevious: false,
    },
    prepare: emptyPrepare(),
    programs: [],
    hardware: {
      nvidia: null,
      speech: { using: "cpu", summary: "CPU (no NVIDIA GPU)", problem: null },
      video: {
        using: "cpu",
        summary: "libx264 and libx265 (software), decoding in software",
        problem: null,
      },
    },
    cpu: { processors: 8, running: 0, budget: 8 },
    gpu: { total: 0, perJob: 0, slots: [] },
    counts: emptyCounts(),
  };
}

export function createEmptyWorld(now: number): World {
  const harness = emptyHarness();
  return {
    users: [],
    sessions: new Map(),
    needsSetup: false,
    setupToken: "setup-token-for-tests",
    serverVersion: "1.0.0",
    startAs: "admin",

    channels: [],
    defaultPrompt: "Edit the video in the style of the channel.",
    workspaceFails: null,

    videos: [],
    archived: [],
    libraryFails: false,

    jobs: [],
    jobLogs: {},
    launches: {},
    failJobsWith: null,

    dataDir: "/Users/vidai/VidAI Data",
    fsPlaces: [],
    fs: [],
    uploads: [],

    adminSettings: {
      setup: "claudeSubscription",
      maxEdits: 3,
      maxTimelineEdits: 2,
      maxRenders: 1,
      maxEditsPerUser: 2,
      startDelayMinutes: 10,
      maxModelRetries: 5,
      cpuPerEditPercent: 50,
      cpuTotalPercent: 100,
      gpuPerEditPercent: 50,
      gpuTotalPercent: 100,
      maxUploadGb: 50,
      proxyCacheGb: 20,
    },
    harness,
    harnessPublic: {
      setup: harness.setup,
      program: harness.program,
      model: null,
      modelName: null,
      effort: null,
    },
    readinessAdmin: { problem: null, message: null },
    readinessUser: { problem: null, message: null },
    apiModels: {},

    timelines: {},
    diskSizes: {},
    cleanLeftover: {},

    system: emptySystem(now),
    usage: {
      claude: { available: true, limits: [], fetchedAt: now, error: null },
      opencode: null,
    },

    editLog: [],
    idCounter: 0,
  };
}
