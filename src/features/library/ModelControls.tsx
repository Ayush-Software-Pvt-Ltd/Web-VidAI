/**
 * Right side of the main top bar, part 1 (SPEC sections 5 and 16): what new edits run with, as one
 * quiet line: the program, the model and the reasoning effort ("Claude Code · Opus 5.5 · High").
 * The model and the effort are the admin's choice for everybody, so nobody picks here: a user
 * gets a read-only line, an admin the same line as a link to Admin, Harness and Model, where it
 * is changed. It reads the public harness state, which the server announces when it changes.
 */
import { ChevronRight, Sparkles } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { fieldBase } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useAppState, useAppStoreApi, useIsAdmin } from "@/lib/appEnv";
import { SETUP_INFO } from "@/lib/setup";
import type { HarnessPublicView } from "@/lib/types";
import { effortLabel } from "./presentation";

const LINE_CLASS =
  "inline-flex h-6 w-auto max-w-[300px] min-w-0 items-center gap-1.5 pr-1.5 pl-2 text-left text-sm [&_svg]:size-3.5 [&_svg]:shrink-0 topbar-max-960:max-w-[220px] topbar-max-820:max-w-[160px]";

/** The model as people read it: its name, else Claude Code's default, else "no model chosen". */
function modelText({ setup, model, modelName }: HarnessPublicView): string {
  if (model !== null) return modelName ?? model;
  return setup === "claudeSubscription" ? "Default model" : "No model chosen";
}

/** "New edits run with Claude Code on Claude Subscription with Opus 5.5 at High effort." */
function sentenceOf(harness: HarnessPublicView): string {
  const info = SETUP_INFO[harness.setup];
  const effort = harness.effort === null ? "" : ` at ${effortLabel(harness.effort)} effort`;
  return `New edits run with ${info.programName} on ${info.service} with ${modelText(harness)}${effort}.`;
}

export function ModelControls() {
  const harness = useAppState((s) => s.harness.data);
  const admin = useIsAdmin();
  const store = useAppStoreApi();
  if (!harness) return null;

  const sentence = sentenceOf(harness);
  const content = (
    <>
      <Sparkles className="text-fg-muted" />
      <span className="shrink-0 text-fg-muted topbar-max-820:hidden">
        {SETUP_INFO[harness.setup].programName}
      </span>
      <span className="text-fg-subtle topbar-max-820:hidden" aria-hidden>
        {"·"}
      </span>
      <span className="min-w-0 flex-1 truncate">{modelText(harness)}</span>
      {harness.effort !== null && (
        <span className="shrink-0 text-fg-muted topbar-max-900:hidden">
          {effortLabel(harness.effort)}
        </span>
      )}
    </>
  );

  if (!admin) {
    return (
      <Tooltip content={`${sentence} The admin chooses it.`} side="bottom">
        <span
          role="group"
          aria-label={sentence}
          tabIndex={0}
          className={cn(fieldBase, LINE_CLASS, "bg-control text-fg hover:border-border")}
        >
          {content}
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={`${sentence} Change it in Admin, Harness and Model.`} side="bottom">
      <button
        type="button"
        aria-label={`${sentence} Open Admin, Harness and Model`}
        onClick={() => {
          store.getState().openAdmin("harness");
        }}
        className={cn(fieldBase, LINE_CLASS, "bg-control shadow-control hover:bg-control-hover")}
      >
        {content}
        <ChevronRight className="text-fg-subtle" />
      </button>
    </Tooltip>
  );
}
