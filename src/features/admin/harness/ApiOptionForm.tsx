/**
 * The form of one API option: API URL, API Key, Model and, when asked for, Reasoning effort and
 * Test. It reads the admin's harness state and writes through the admin functions, each field on its own (URL
 * and a typed model on Return or blur, key with Save, a chosen model and effort on choosing).
 * OpenCode Go's model is chosen from its searchable list, which is fetched when the form opens
 * and when its URL or key changes; the other two options take a typed model id and ask the
 * service for a list only when Fetch Models is pressed. The same component is on the option's card
 * in Admin, Harness and Model.
 *
 * Props:
 * - `option`: which API option (`opencodeGo`, `anthropicApi` or `openaiApi`).
 * - `effort`: also show "Reasoning effort" (a Select per model). Default false.
 * - `test`: also show "Test the connection" with its result. Default false.
 * - `className`: classes of the outer column (the form brings no box and no padding of its own).
 *
 * The key is optional on the Anthropic and OpenAI compatible options (a server on the admin's
 * own network often needs none; SPEC section 5). What the option can do so far (key saved, model chosen, why
 * not) is `useApiOption(option)`.
 */
import { PlugZap } from "lucide-react";
import { useEffect, useId } from "react";
import { Button, Select } from "@/components/ui";
import { effortLabel } from "@/features/library/presentation";
import { Callout, Row, useAction } from "@/features/settings";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { API_EFFORTS, SETUP_INFO } from "@/lib/setup";
import type { ApiOption } from "@/lib/types";
import { ApiKeyField } from "./ApiKeyField";
import { ApiModelField } from "./ApiModelField";
import { ApiUrlField } from "./ApiUrlField";
import { ModelCombobox } from "./ModelCombobox";
import { effortHint, fetchProblem } from "./model";
import { useApiOption, useHarnessCommit } from "./useApiOption";

export interface ApiOptionFormProps {
  option: ApiOption;
  /** Also show Reasoning effort. */
  effort?: boolean;
  /** Also show Test the connection. */
  test?: boolean;
  className?: string;
}

export function ApiOptionForm({
  option,
  effort = false,
  test = false,
  className,
}: ApiOptionFormProps) {
  const store = useAppStoreApi();
  // OpenCode Go's list is asked for when the form opens, unless one was fetched already; the
  // other options fetch only on demand.
  const fetched = useAppState((s) => s.apiModels[option].data?.fetchedAt != null);
  useEffect(() => {
    if (
      option === "opencodeGo" &&
      !fetched &&
      store.getState().apiModels[option].status !== "loading"
    ) {
      void store.getState().loadApiModels(option, true);
    }
    // Once per opening: a failed request is retried with Try Again, not in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, store]);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ApiUrlField option={option} />
      <ApiKeyField option={option} test={test} />
      {option === "opencodeGo" ? (
        <ModelField option={option} />
      ) : (
        <TypedModelField option={option} />
      )}
      {effort && <EffortField option={option} />}
      {test && <TestField option={option} />}
    </div>
  );
}

function ModelField({ option }: { option: ApiOption }) {
  const api = useApi();
  const store = useAppStoreApi();
  const commit = useHarnessCommit();
  const { model, loaded } = useApiOption(option);
  const id = useId();

  const choose = useAction(async (next: string) => {
    store.getState().clearApiTest(option);
    await commit(api.adminSetApiModel({ option, model: next }));
  });

  return (
    <Row
      className="p-0"
      label="Model"
      labelFor={id}
      description="Every edit on this option uses this model, also for its sub-agents and background tasks."
    >
      <ModelCombobox
        id={id}
        option={option}
        value={model}
        disabled={!loaded || choose.pending}
        onChange={(next) => void choose.run(next)}
      />
      {choose.error && (
        <p role="alert" className="text-sm text-danger">
          {choose.error.message}
        </p>
      )}
    </Row>
  );
}

function TypedModelField({ option }: { option: ApiOption }) {
  const { loaded } = useApiOption(option);
  return <ApiModelField option={option} disabled={!loaded} />;
}

function EffortField({ option }: { option: ApiOption }) {
  const api = useApi();
  const commit = useHarnessCommit();
  const { model, efforts } = useApiOption(option);
  const id = useId();

  const choose = useAction(async (modelId: string, level: string) => {
    await commit(
      api.adminSetApiEffort({ option, model: modelId, effort: level === "default" ? null : level }),
    );
  });

  return (
    <Row
      className="p-0"
      label="Reasoning effort"
      labelFor={id}
      description={effortHint(option)}
      control={
        <Select
          id={id}
          className="min-w-[120px]"
          value={model ? (efforts[model] ?? "default") : "default"}
          options={[
            { value: "default", label: "Default" },
            ...API_EFFORTS.map((level) => ({ value: level, label: effortLabel(level) })),
          ]}
          disabled={!model || choose.pending}
          onValueChange={(level) => {
            if (model) void choose.run(model, level);
          }}
        />
      }
    >
      {choose.error && (
        <p role="alert" className="text-sm text-danger">
          {choose.error.message}
        </p>
      )}
    </Row>
  );
}

function TestField({ option }: { option: ApiOption }) {
  const store = useAppStoreApi();
  const { keySaved, model } = useApiOption(option);
  const result = useAppState((s) => s.apiTests[option]);
  const blocked = fetchProblem(option, keySaved) !== null;
  const service = SETUP_INFO[option].service;

  return (
    <Row
      className="p-0"
      label="Test the connection"
      description={`Sends one tiny request to ${service} (one output token) with the address, the model and the key, if there is one.`}
      control={
        <Button
          icon={<PlugZap />}
          loading={result.status === "loading"}
          disabled={blocked || model === null}
          onClick={() => void store.getState().testApi(option)}
        >
          Test
        </Button>
      }
    >
      {result.status === "ready" && result.data?.ok === true && (
        <Callout tone="success" live title={result.data.message} />
      )}
      {result.status === "ready" && result.data?.ok === false && (
        <Callout tone="danger" live title={`${service} did not answer as expected`}>
          {result.data.message}
        </Callout>
      )}
      {result.status === "error" && (
        <Callout tone="danger" live title={`${service} did not answer as expected`}>
          {result.error?.message}
        </Callout>
      )}
    </Row>
  );
}
