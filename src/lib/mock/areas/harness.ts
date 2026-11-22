/**
 * The harness area (SPEC section 5, "Harness, program and model"): the admin's setup, address,
 * key, model and effort of the four setups, the model lists and the Test request. Every setter
 * answers the whole `HarnessAdminState` (as the server does), keeps the public harness and the
 * readiness in step and sends `settings-changed` with the public view to everybody.
 *
 * The rules and sentences are those of `server/src/agents/setupsService.js`: an option can only
 * be selected with its key (OpenCode Go only) and a model; removing OpenCode Go's key, or the
 * model of the selected option, falls back to the Claude subscription; the Claude effort must be
 * one the chosen model supports; efforts are kept per model. The rules about addresses, keys and
 * which service refuses what are in `apiRules.ts`. Non-admins get `forbidden`.
 *
 * The keys are kept in the world's sim (`harnessSim`): the wire never carries one.
 */
import type { Api } from "../../api";
import {
  API_DEFAULT_BASE_URL,
  API_EFFORTS,
  API_OPTIONS,
  SETUP_INFO,
  noModelText,
} from "../../setup";
import type { ApiModels, ApiOption, HarnessAdminState, Setup } from "../../types";
import {
  isBadKey,
  isUnreachable,
  modelsFor,
  normalizeBaseUrl,
  testOutcome,
  unreachableText,
} from "../apiRules";
import type { MockCtx } from "../ctx";
import { harnessSim, putKey, syncHarness } from "../seed/harness";

// eslint-disable-next-line no-control-regex -- a key or model id never holds control characters
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/u;

export function harnessArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  const sim = harnessSim(world);

  const checkedOption = (value: unknown): ApiOption => {
    const found = API_OPTIONS.find((option) => option === value);
    if (found === undefined) throw ctx.errors.invalidInput("That is not one of the API options.");
    return found;
  };

  const modelId = (value: unknown): string => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "" || SPACE_OR_CONTROL.test(text)) {
      throw ctx.errors.invalidInput("That is not a model id.");
    }
    return text;
  };

  const checkEffort = (value: unknown): string => {
    const found = API_EFFORTS.find((effort) => effort === value);
    if (found === undefined) {
      throw ctx.errors.invalidInput(
        `The reasoning effort must be one of: ${API_EFFORTS.join(", ")}.`,
      );
    }
    return found;
  };

  const optionalText = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;

  /** On the selected option: edits go back to the Claude subscription. */
  const fallBackToClaude = (option: ApiOption) => {
    if (world.harness.setup === option) {
      world.harness.setup = "claudeSubscription";
      world.harness.program = SETUP_INFO.claudeSubscription.program;
    }
  };

  /** Keeps the public harness and the readiness in step, tells everybody, answers the screen. */
  const changed = (): HarnessAdminState => {
    syncHarness(world);
    const { setup, maxUploadGb, maxEditsPerUser, startDelayMinutes } = world.adminSettings;
    ctx.emit("settings-changed", {
      setup,
      maxUploadGb,
      maxEditsPerUser,
      startDelayMinutes,
      harness: { ...world.harnessPublic },
    });
    return world.harness;
  };

  const selectionProblem = (option: ApiOption): string | null => {
    const state = world.harness.options[option];
    if (state.keyRequired && !state.key.saved) {
      return state.model === null
        ? "Save an API key and choose a model first."
        : "Save an API key first.";
    }
    return state.model === null ? noModelText(option) : null;
  };

  const displayName = (option: ApiOption, id: string): string =>
    world.apiModels[option]?.models.find((m) => m.id === id)?.displayName ?? id;

  return {
    adminGetHarness: () =>
      ctx.run(() => {
        ctx.requireAdmin();
        return world.harness;
      }),

    adminSetSetup: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const known = (Object.keys(SETUP_INFO) as Setup[]).find((name) => name === input.setup);
        if (known === undefined) {
          throw ctx.errors.invalidInput("That is not one of the four setups.");
        }
        const option = SETUP_INFO[known].option;
        if (option !== null) {
          const problem = selectionProblem(option);
          if (problem !== null) throw ctx.errors.invalidInput(problem);
        }
        world.harness.setup = known;
        world.harness.program = SETUP_INFO[known].program;
        return changed();
      }),

    adminSetApiBaseUrl: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        let normalized: string | null;
        try {
          normalized = normalizeBaseUrl(option, input.baseUrl ?? "");
        } catch (error) {
          throw ctx.errors.invalidInput(error instanceof Error ? error.message : undefined);
        }
        const state = world.harness.options[option];
        state.baseUrl = normalized;
        state.effectiveBaseUrl = normalized ?? API_DEFAULT_BASE_URL[option];
        return changed();
      }),

    adminSetApiKey: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        const text = typeof input.key === "string" ? input.key.trim() : "";
        if (text === "") throw ctx.errors.invalidInput("Enter an API key.");
        if (SPACE_OR_CONTROL.test(text)) {
          throw ctx.errors.invalidInput(
            "An API key has no spaces or line breaks. Copy it again and paste only the key.",
          );
        }
        putKey(world, option, text);
        return changed();
      }),

    adminClearApiKey: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        putKey(world, option, null);
        if (world.harness.options[option].keyRequired) fallBackToClaude(option);
        return changed();
      }),

    adminSetApiModel: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        const text = optionalText(input.model);
        const clean = text === null ? null : modelId(text);
        world.harness.options[option].model = clean;
        if (clean === null) fallBackToClaude(option);
        return changed();
      }),

    adminSetApiEffort: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        const id = modelId(input.model);
        const effort = input.effort === null ? null : checkEffort(input.effort);
        const stored = world.harness.options[option];
        stored.efforts =
          effort === null
            ? Object.fromEntries(Object.entries(stored.efforts).filter(([model]) => model !== id))
            : { ...stored.efforts, [id]: effort };
        return changed();
      }),

    adminSetModelSelection: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const model = optionalText(input.model) === null ? null : modelId(input.model);
        const effort = optionalText(input.effort) === null ? null : checkEffort(input.effort);
        if (effort !== null) {
          const info = world.harness.claude.models.find((m) => m.value === model);
          if (info !== undefined && !info.effortLevels.includes(effort)) {
            throw ctx.errors.invalidInput(
              info.effortLevels.length === 0
                ? `${info.displayName} has no reasoning effort to choose.`
                : `${info.displayName} supports these reasoning efforts: ${info.effortLevels.join(", ")}.`,
            );
          }
        }
        world.harness.claude.model = model;
        world.harness.claude.effort = effort;
        return changed();
      }),

    adminGetApiModels: async (input) => {
      const refresh = input.refresh === true;
      if (refresh && sim.modelsDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sim.modelsDelayMs));
      }
      return ctx.run((): ApiModels => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        const baseUrl = world.harness.options[option].effectiveBaseUrl;
        if (!refresh) {
          const kept = world.apiModels[option];
          return kept?.baseUrl === baseUrl
            ? kept
            : { option, baseUrl, models: [], fetchedAt: null };
        }
        if (sim.modelsFail || isUnreachable(baseUrl)) {
          throw ctx.errors.io(unreachableText(baseUrl));
        }
        const key = sim.keys[option];
        if (key !== null && isBadKey(key)) {
          throw ctx.errors.io(testOutcome(option, baseUrl, key, "", "").message);
        }
        const fresh: ApiModels = {
          option,
          baseUrl,
          models: modelsFor(option, baseUrl).map((m) => ({ ...m })),
          fetchedAt: ctx.clock.now(),
        };
        // Only OpenCode Go's list is kept; the other two are fetched on demand.
        if (option === "opencodeGo") world.apiModels[option] = fresh;
        return fresh;
      });
    },

    adminTestApi: (input) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const option = checkedOption(input.option);
        const state = world.harness.options[option];
        if (state.keyRequired && !state.key.saved) {
          throw ctx.errors.invalidInput("No API key is saved for this option. Save a key first.");
        }
        if (state.model === null) throw ctx.errors.invalidInput(noModelText(option));
        if (isUnreachable(state.effectiveBaseUrl)) {
          return { ok: false, message: unreachableText(state.effectiveBaseUrl) };
        }
        return testOutcome(
          option,
          state.effectiveBaseUrl,
          sim.keys[option],
          state.model,
          displayName(option, state.model),
        );
      }),
  };
}
