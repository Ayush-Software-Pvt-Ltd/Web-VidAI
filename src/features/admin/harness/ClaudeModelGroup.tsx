/**
 * Admin, Harness and Model, "Claude model" (SPEC section 5): the model and reasoning effort of the
 * Claude subscription (`adminSetModelSelection`), saved at once. Claude Code's own default is
 * "Default". The effort choices are the ones the chosen model supports, as Claude Code lists them;
 * a model that has none shows no choice. A line says that a change applies to new edits only.
 */
import { useId } from "react";
import { Select } from "@/components/ui";
import { effortLabel } from "@/features/library/presentation";
import { Group, Row, useAction } from "@/features/settings";
import { useApi } from "@/lib/appEnv";
import { API_EFFORTS } from "@/lib/setup";
import { useHarnessCommit, useHarnessState } from "./useApiOption";

export const NEW_EDITS_NOTE =
  "A change applies to new edits. An edit that already runs keeps the model and effort it started with.";

export function ClaudeModelGroup() {
  const api = useApi();
  const commit = useHarnessCommit();
  const state = useHarnessState();
  const modelId = useId();
  const effortId = useId();
  const save = useAction(async (model: string | null, effort: string | null) => {
    await commit(api.adminSetModelSelection({ model, effort }));
  });
  if (state === null) return null;

  const { model, effort, models } = state.claude;
  const info = models.find((m) => m.value === model) ?? null;
  // The efforts the model supports; every level while the model is not in Claude Code's list.
  const levels = info === null ? API_EFFORTS : info.effortLevels;
  const options = [
    { value: "default", label: "Default" },
    ...models.map((m) => ({ value: m.value, label: m.displayName, description: m.description })),
    ...(model !== null && info === null ? [{ value: model, label: model }] : []),
  ];

  return (
    <Group
      title="Claude model"
      description="Used when edits run on Claude Code with the Claude subscription."
      footer={NEW_EDITS_NOTE}
    >
      <Row
        label="Model"
        labelFor={modelId}
        description="Every edit on the Claude subscription uses this model, also for its sub-agents."
        control={
          <Select
            id={modelId}
            className="min-w-[160px]"
            value={model ?? "default"}
            options={options}
            disabled={save.pending}
            onValueChange={(next) => {
              const value = next === "default" ? null : next;
              const supported = models.find((m) => m.value === value)?.effortLevels ?? API_EFFORTS;
              // An effort the new model does not have would be refused: go back to the default.
              void save.run(value, effort !== null && supported.includes(effort) ? effort : null);
            }}
          />
        }
      />
      <Row
        label="Reasoning effort"
        labelFor={effortId}
        description={
          info !== null && levels.length === 0
            ? `${info.displayName} has no reasoning effort to choose.`
            : "How hard the model thinks. Default sends nothing."
        }
        control={
          <Select
            id={effortId}
            className="min-w-[120px]"
            value={effort ?? "default"}
            options={[
              { value: "default", label: "Default" },
              ...levels.map((level) => ({ value: level, label: effortLabel(level) })),
            ]}
            disabled={save.pending || (info !== null && levels.length === 0)}
            onValueChange={(next) => {
              void save.run(model, next === "default" ? null : next);
            }}
          />
        }
      >
        {save.error && (
          <p role="alert" className="text-sm text-danger">
            {save.error.message}
          </p>
        )}
      </Row>
    </Group>
  );
}
