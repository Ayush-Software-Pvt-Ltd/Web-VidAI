/**
 * Admin, Harness and Model, "How should VidAI run edits?" (SPEC sections 5 and 16): the four
 * options as radio cards. Choosing one is one change on the server (`adminSetSetup`), saved at
 * once for everybody; a refused one puts the saved choice back. Every API card has a Configure toggle that opens the
 * form of its option whether or not it is selected (the selected one starts open); an API card
 * cannot be selected before its option can run an edit, and says why. Under option 1 a note says
 * when the user's own setup points Claude Code somewhere else.
 */
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button, toast } from "@/components/ui";
import { Callout, Group } from "@/features/settings";
import { useApi } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { toApiError } from "@/lib/errors";
import { SETUP_INFO, SETUPS } from "@/lib/setup";
import type { ApiOption, ClaudeRouting, Setup } from "@/lib/types";
import { ApiOptionForm } from "./ApiOptionForm";
import { RadioCard } from "./RadioCard";
import { useApiOption, useHarnessCommit, useHarnessState } from "./useApiOption";

/** An edit keeps the setup its session started on, also Continue, Re-Edit and Render Final. */
export const SETUP_KEPT_NOTE =
  "An edit underway and the follow-ups of an earlier edit stay on the setup their session started on.";

export function SetupGroup() {
  const api = useApi();
  const commit = useHarnessCommit();
  const harness = useHarnessState();
  // The choice being saved, shown right away.
  const [choosing, setChoosing] = useState<Setup | null>(null);
  // What the user opened or closed with Configure; an API card the user did not touch is open
  // while it is the selected one.
  const [toggled, setToggled] = useState<Partial<Record<ApiOption, boolean>>>({});

  const selected = choosing ?? harness?.setup ?? null;

  const choose = async (next: Setup) => {
    if (!harness || next === harness.setup) return;
    setChoosing(next);
    try {
      await commit(api.adminSetSetup({ setup: next }));
      const info = SETUP_INFO[next];
      toast.success(
        `New edits run with ${info.programName} on ${info.service}`,
        "Edits that already started keep the setup they started on.",
      );
    } catch (error) {
      toast.error("The setup was not changed", toApiError(error).message);
    } finally {
      setChoosing(null);
    }
  };

  return (
    <Group title="How should VidAI run edits?" footer={SETUP_KEPT_NOTE}>
      <div
        role="radiogroup"
        aria-label="How should VidAI run edits?"
        className="flex flex-col divide-y divide-separator"
      >
        {SETUPS.map((setup) => {
          const option = SETUP_INFO[setup].option;
          return (
            <SetupCard
              key={setup}
              setup={setup}
              checked={selected === setup}
              busy={harness === null || choosing !== null}
              open={option !== null && (toggled[option] ?? selected === setup)}
              onToggle={(open) => {
                if (option !== null) setToggled((t) => ({ ...t, [option]: open }));
              }}
              onChoose={() => void choose(setup)}
            />
          );
        })}
      </div>
    </Group>
  );
}

function SetupCard({
  setup,
  checked,
  busy,
  open,
  onToggle,
  onChoose,
}: {
  setup: Setup;
  checked: boolean;
  busy: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  onChoose: () => void;
}) {
  const info = SETUP_INFO[setup];
  const option = info.option;
  const panelId = useId();
  const routing = useHarnessState()?.claudeRouting ?? null;
  // Only an API option has a key and a model; the hook is called for the others and ignored.
  const state = useApiOption(option ?? "opencodeGo");
  const needsOption = option !== null;
  const problem = needsOption && !checked ? state.problem : null;

  return (
    <RadioCard
      name="how-edits-run"
      value={setup}
      title={info.label}
      description={info.line}
      checked={checked}
      disabled={busy || (needsOption && !checked && problem !== null)}
      reason={problem}
      onChoose={onChoose}
      aside={
        option !== null && (
          <Button
            variant="secondary"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`Configure ${info.label}`}
            icon={<ChevronDown className={cn("transition-transform", open && "rotate-180")} />}
            onClick={() => {
              onToggle(!open);
            }}
          >
            Configure
          </Button>
        )
      }
    >
      {setup === "claudeSubscription" && routing && <RoutingNote routing={routing} />}
      {option !== null && open && (
        <div
          id={panelId}
          role="group"
          aria-label={`Settings of ${info.label}`}
          className="mt-3 rounded-md border border-border-container bg-subtle p-4"
        >
          <ApiOptionForm option={option} effort test />
        </div>
      )}
    </RadioCard>
  );
}

/** The server's own Claude Code setup points somewhere else: say what "Claude Subscription" means. */
function RoutingNote({ routing }: { routing: ClaudeRouting }) {
  const setup = useHarnessState()?.setup ?? null;
  const where =
    routing.source === "claudeSettings"
      ? "the env of the Claude Code settings file on the computer that runs VidAI"
      : "ANTHROPIC_BASE_URL in the environment of the computer that runs VidAI";
  return (
    <Callout tone="warning" className="mt-2.5" title="Claude Code is pointed at another service">
      The server's own setup sends Claude Code to{" "}
      <span className="break-all">{routing.baseUrl}</span> (set by {where}). VidAI leaves that
      alone, so edits with the Claude Subscription go there, not to your Claude plan.
      {setup === "anthropicApi" &&
        routing.source === "claudeSettings" &&
        " Claude Code applies that file over what VidAI sets, so edits on the Anthropic Compatible API may not reach it either."}
    </Callout>
  );
}
