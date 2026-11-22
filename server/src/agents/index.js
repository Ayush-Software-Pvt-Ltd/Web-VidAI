// The harness module (docs/SPEC.md section 5, "Harness, program and model"): the four setups,
// their API addresses, keys, models and efforts, readiness, and the OpenCode Go quota, as admin
// settings of the whole server. `createHarnessModule(deps)` is the one thing the server's wiring
// calls; the job engine takes what it needs (`launchFor`, `jobEnv`, `ensureReady`,
// `secretsToScrub`) from its answer.
//
//   const harness = createHarnessModule({ settingsRepo, settings, secrets, events, clock, version, probes });
//   rpc.register(harness.rpc);
//   harness.start();

import { adminHarnessFunctions } from "../rpc/adminHarness.js";
import { createApiHttp } from "./apiHttp.js";
import { detectRouting as detectRoutingDefault } from "./opencode/routing.js";
import { createUsageService } from "./opencode/usage.js";
import { createSetupStore } from "./setupStore.js";
import { defaultBaseUrl, keyName } from "./setups.js";
import { jobEnv } from "./setupsJob.js";
import { createSetupsService } from "./setupsService.js";

/** @typedef {import("../../../src/lib/wire/harness.ts").ClaudeModelInfo} ClaudeModelInfo */

/** How often the OpenCode Go quota is asked while edits run on OpenCode Go. */
const USAGE_INTERVAL_MS = 60_000;

/**
 * @typedef {object} HarnessDeps Everything is injected; nothing here is global.
 * @property {ReturnType<typeof import("../db/settings.js").createSettingsRepo>} settingsRepo
 * @property {ReturnType<typeof import("../settings.js").createSettings>} settings
 * @property {ReturnType<typeof import("../secrets.js").createSecrets>} secrets
 * @property {import("../rpc/index.js").Events} events
 * @property {import("../db/open.js").Clock} clock
 * @property {string} version The server's version, sent as `VidAI/<version>` to a service.
 * @property {import("./readiness.js").ReadinessProbes} probes
 * @property {typeof fetch} [fetch] Default: Node's own.
 * @property {Partial<import("./apiHttp.js").HttpTimings>} [timings]
 * @property {() => Promise<ClaudeModelInfo[]>} [claudeModels] Default: none known.
 * @property {() => Promise<import("../../../src/lib/wire/harness.ts").ClaudeRouting | null>} [detectRouting]
 * @property {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [timers]
 * @property {number} [usageIntervalMs]
 */

/**
 * @param {HarnessDeps} deps
 */
export function createHarnessModule(deps) {
  const { settings, secrets, events, clock } = deps;
  const timers = deps.timers ?? { setInterval, clearInterval };
  const http = createApiHttp({ fetch: deps.fetch, version: deps.version, timings: deps.timings });
  const store = createSetupStore({ repo: deps.settingsRepo });

  const usage = createUsageService({
    clock,
    getWithKey: (url, key) => http.getWithKey(url, key),
    selected: () => settings.getAll().setup === "opencodeGo",
    key: () => secrets.get(keyName("opencodeGo")),
    baseUrl: () => store.option("opencodeGo").baseUrl ?? defaultBaseUrl("opencodeGo"),
    onUpdate: (status) =>
      events.emit({
        event: "usage-updated",
        payload: { opencode: status },
        userId: null,
        admins: false,
      }),
  });

  /** @type {ReturnType<typeof createSetupsService>} */
  const service = createSetupsService({
    store,
    settings,
    secrets,
    clock,
    http,
    usage,
    probes: deps.probes,
    claudeModels: deps.claudeModels ?? (async () => []),
    detectRouting: deps.detectRouting ?? (() => detectRoutingDefault()),
    // The public part of `settings-changed` plus what users may see of the harness.
    async onChange() {
      events.emit({
        event: "settings-changed",
        payload: { ...settings.publicView(), harness: await service.publicView() },
        userId: null,
        admins: false,
      });
    },
  });

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  return {
    name: "harness",
    rpc: adminHarnessFunctions(service, { usage }),
    service,
    usage,

    /** Checks the saved Claude model and effort against a new model list (see the service). */
    recheckClaudeSelection: service.recheckClaudeSelection,

    /** What users see of the harness, read-only. */
    publicView: () => service.publicView(),
    /** What a new job on a setup is started with (holds the key; never sent anywhere else). */
    launchFor: service.launchFor,
    jobEnv,
    secretsToScrub: service.secretsToScrub,
    checkReadiness: service.checkReadiness,
    ensureReady: service.ensureReady,

    /** Starts the quota schedule: once now, then every minute while edits run on OpenCode Go. */
    start() {
      if (timer !== null) return;
      void usage.refresh();
      const every = deps.usageIntervalMs ?? USAGE_INTERVAL_MS;
      timer = timers.setInterval(
        () => {
          if (usage.due(every)) void usage.refresh();
        },
        Math.min(every, 5000),
      );
      timer.unref?.();
    },

    /** Stops the schedule. */
    stop() {
      if (timer === null) return;
      timers.clearInterval(timer);
      timer = null;
    },
  };
}
