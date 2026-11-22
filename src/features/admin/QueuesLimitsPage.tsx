/**
 * Admin, Queues and Limits (SPEC sections 5 and 9): how many edits, timeline changes and renders
 * run at the same time, the share one user may take, the pause between starts, retries after a
 * model error, and the processor and graphics card limits. A draft with Save: it applies at once.
 */
import { Callout, Group, SettingsPage } from "@/features/settings";
import { EmptyState, Spinner } from "@/components/ui";
import { ChoiceRow, NumberRow, SaveBar } from "./fields";
import {
  limitedByTotal,
  numberOptions,
  PERCENT_MAX,
  PERCENT_MIN,
  PERCENT_STEP,
  type NumberKey,
} from "./rules";
import { useSettingsDraft } from "./useSettingsDraft";

const KEYS: readonly NumberKey[] = [
  "maxEdits",
  "maxTimelineEdits",
  "maxRenders",
  "maxEditsPerUser",
  "startDelayMinutes",
  "maxModelRetries",
  "cpuPerEditPercent",
  "cpuTotalPercent",
  "gpuPerEditPercent",
  "gpuTotalPercent",
];

const LABELS: Record<string, string> = {
  maxEdits: "edits at the same time",
  maxTimelineEdits: "timeline changes at the same time",
  maxRenders: "renders at the same time",
  maxEditsPerUser: "edits per user",
  startDelayMinutes: "delay between edit starts",
  maxModelRetries: "retries after a model error",
  cpuPerEditPercent: "processor limit per edit",
  cpuTotalPercent: "processor limit in total",
  gpuPerEditPercent: "graphics card limit per edit",
  gpuTotalPercent: "graphics card limit in total",
};

const PERCENTS = numberOptions(PERCENT_MIN, PERCENT_MAX, PERCENT_STEP, (n) => `${String(n)}%`);

export function QueuesLimitsPage() {
  const draft = useSettingsDraft(KEYS, {
    name: "Queues and Limits",
    label: (key) => LABELS[key] ?? key,
  });
  const { data, status, error } = draft.settings;

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        {status === "error" && error ? (
          <EmptyState
            tone="error"
            title="The settings could not be loaded"
            description={error.message}
          />
        ) : (
          <Spinner label="Loading the settings" />
        )}
      </div>
    );
  }

  const cpuLimit = limitedByTotal(draft.text("cpuPerEditPercent"), draft.text("cpuTotalPercent"));
  const gpuLimit = limitedByTotal(draft.text("gpuPerEditPercent"), draft.text("gpuTotalPercent"));

  return (
    <SettingsPage>
      <Callout tone="info">
        Saving applies at once to everybody. Waiting edits start right away when more room is made,
        and edits that already run are never interrupted by a lower number.
      </Callout>

      <Group
        title="At the same time"
        description="Each of the three lines of the queue has its own number of slots. The rest wait their turn."
      >
        <ChoiceRow
          draft={draft}
          field="maxEdits"
          label="Edits"
          description="How many videos the agent edits at the same time, over all users. More at once reaches the model provider's limits sooner."
          options={numberOptions(1, 8)}
        />
        <ChoiceRow
          draft={draft}
          field="maxTimelineEdits"
          label="Timeline changes"
          description="How many changes made on a timeline are worked in at the same time."
          options={numberOptions(1, 8)}
        />
        <ChoiceRow
          draft={draft}
          field="maxRenders"
          label="Renders"
          description="How many renders run at the same time. A render is heavy on the processor and the graphics card."
          options={numberOptions(1, 4)}
        />
        <ChoiceRow
          draft={draft}
          field="maxEditsPerUser"
          label="Edits per user"
          description="How many edits one user may have running at the same time, so one person cannot take every slot. Their other edits wait."
          options={numberOptions(0, 8, 1, (n) => (n === 0 ? "No limit" : String(n)))}
        />
      </Group>

      <Group title="Pacing">
        <NumberRow
          draft={draft}
          field="startDelayMinutes"
          label="Delay between edit starts"
          description="While an edit runs, the next one waits this long after the last start, so edits do not all load the processor and graphics card at once. The first edit always starts right away, and 0 turns the delay off."
          unit="minutes"
        />
        <NumberRow
          draft={draft}
          field="maxModelRetries"
          label="Retries after a model error"
          description="When the model provider fails (overloaded, rate limited, network trouble), VidAI waits and continues the same edit by itself, up to this many times in a row. The waits grow from 30 seconds to 15 minutes, and a retry count starts over when the edit makes progress. 0 turns retries off."
          unit="retries"
        />
      </Group>

      <Group
        title="Processor and graphics card"
        description="How much of this computer an edit may use. The limits are shares of the whole machine, not hard walls."
        footer={
          <>
            An edit never takes more than the total, so the lower of the two numbers counts. The
            graphics card numbers are approximate: not every card reports its load the same way.
          </>
        }
      >
        <ChoiceRow
          draft={draft}
          field="cpuPerEditPercent"
          label="Processor, per edit"
          description={cpuLimit !== null && <LimitedByTotal total={cpuLimit} />}
          options={PERCENTS}
        />
        <ChoiceRow
          draft={draft}
          field="cpuTotalPercent"
          label="Processor, in total"
          options={PERCENTS}
        />
        <ChoiceRow
          draft={draft}
          field="gpuPerEditPercent"
          label="Graphics card, per edit (approximate)"
          description={gpuLimit !== null && <LimitedByTotal total={gpuLimit} />}
          options={PERCENTS}
        />
        <ChoiceRow
          draft={draft}
          field="gpuTotalPercent"
          label="Graphics card, in total (approximate)"
          options={PERCENTS}
        />
      </Group>

      <SaveBar draft={draft} />
    </SettingsPage>
  );
}

/** Said next to a per-edit value above its total: the value is kept, the total counts. */
function LimitedByTotal({ total }: { total: number }) {
  return (
    <span role="status" className="text-warning">
      Limited by the total: an edit gets at most {String(total)}%.
    </span>
  );
}
