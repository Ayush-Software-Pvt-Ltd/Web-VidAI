import { Play, Settings as SettingsIcon, TriangleAlert } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { Button, Field, Select, Sheet, Spinner, Textarea } from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { SETUP_INFO } from "@/lib/setup";
import { videoTypeLabel } from "@/lib/status";
import { agentName } from "./agent";
import { Callout } from "./Callout";
import type { StartDialog } from "./controller";
import { modelAndEffort, startSlots, videoTypeSource } from "./describe";
import { useJobsEnv } from "./env";
import { useLiveVideo } from "./hooks";
import { useStartBlock } from "./readiness";
import { SheetFooter } from "./SheetFooter";
import { UrgentField } from "./UrgentField";
import { useSubmitShortcut } from "./useSubmitShortcut";
import { productLinksProblem } from "./validation";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </>
  );
}

/**
 * Start Editing (SPEC sections 8 and 16): read-only facts, the prompt and style, product links,
 * notes and the Urgent checkbox. When the server says edits cannot start (`getReadiness`) the
 * sheet shows its sentence and the button is off; that is the only rule the page applies itself
 * besides the empty prompt, which the server refuses too.
 */
export function StartEditingSheet({ dialog }: { dialog: StartDialog }) {
  const { controller } = useJobsEnv();
  const store = useAppStoreApi();
  const formId = useId();
  const linksRef = useRef<HTMLTextAreaElement>(null);
  const video = useLiveVideo(dialog.video);
  const channel = useAppState((s) =>
    s.workspace.data?.channels.find((c) => c.id === video.channelId),
  );
  const harness = useAppState((s) => s.harness.data);
  const block = useStartBlock();
  const info = harness ? SETUP_INFO[harness.setup] : null;
  const agent = agentName(harness?.program);
  const channelName = channel?.name ?? video.channelId;
  const slots = startSlots(channel, video, dialog);
  const profile = channel?.[video.videoType];
  const promptMissing = channel !== undefined && slots.prompts.length === 0;
  const slotOptions = (kind: "prompts" | "styles") =>
    slots[kind].map((i) => {
      const slot = profile?.[kind][i];
      const empty = kind === "styles" && slot?.text.trim() === "";
      return {
        value: String(i),
        label: empty ? `${slot.name} (empty - the agent designs one)` : (slot?.name ?? ""),
      };
    });
  const linksError = dialog.showErrors ? productLinksProblem(dialog.productLinks) : null;
  const loading = dialog.prefill === "loading";
  const canSubmit = !promptMissing && !loading && block === null;

  const submit = () => {
    if (!canSubmit) return;
    if (productLinksProblem(dialog.productLinks)) linksRef.current?.focus();
    void controller.submitStart();
  };
  useSubmitShortcut(submit);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
      dismissible={!dialog.submitting}
      title="Start Editing"
      description={<span dir="auto">{video.folderName}</span>}
      footer={
        <SheetFooter
          form={formId}
          submitLabel="Start Editing"
          shortcutHint="to start"
          submitIcon={<Play />}
          submitting={dialog.submitting}
          disabled={!canSubmit}
          onCancel={controller.close}
        />
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {block && (
          <Callout
            tone="warning"
            icon={<TriangleAlert />}
            title={block.title}
            action={
              block.admin ? (
                <Button
                  size="sm"
                  icon={<SettingsIcon />}
                  onClick={() => {
                    store.getState().openAdmin(block.fix === "settings" ? "harness" : "system");
                  }}
                >
                  Open Admin
                </Button>
              ) : undefined
            }
          >
            {block.message}
            {!block.admin && !/\badmin\b/i.test(block.message) && " Ask your admin."}
          </Callout>
        )}

        {dialog.error && (
          <Callout tone="danger" icon={<TriangleAlert />} title="Could not start editing">
            {dialog.error}
          </Callout>
        )}

        {promptMissing && (
          <Callout
            tone="warning"
            icon={<TriangleAlert />}
            title={`The ${videoTypeLabel(video.videoType)} prompt of ${channelName} is empty`}
            action={
              <Button
                size="sm"
                icon={<SettingsIcon />}
                onClick={() => {
                  store.getState().openSettings({
                    section: "channels",
                    channelId: video.channelId,
                    videoType: video.videoType,
                  });
                }}
              >
                Open Settings
              </Button>
            }
          >
            {agent} needs it to know how to edit this video. Write it in Settings, Channels, then
            come back here: what you typed below is kept.
          </Callout>
        )}

        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-1.5 rounded-lg border border-separator bg-subtle px-3.5 py-3 text-base">
          <Fact label="Channel">
            <span dir="auto">{channelName}</span>
          </Fact>
          <Fact label="Type">
            {videoTypeLabel(video.videoType)}
            <span className="text-fg-muted"> ({videoTypeSource(video)})</span>
          </Fact>
          {harness && info && (
            <Fact label={info.option === null ? "Claude" : info.service}>
              {modelAndEffort(harness.modelName, harness.effort)}
              {info.option !== null && (
                <span className="text-fg-muted"> (with {info.programName})</span>
              )}
            </Fact>
          )}
        </dl>

        {profile && !promptMissing && (
          <div className="flex flex-col gap-3">
            <Field label="Prompt">
              {(id) => (
                <Select
                  id={id}
                  className="w-full"
                  disabled={loading}
                  value={String(slots.promptSlot)}
                  options={slotOptions("prompts")}
                  onValueChange={(value) => {
                    controller.update("start", { promptSlot: Number(value) });
                  }}
                />
              )}
            </Field>
            <Field label="Style">
              {(id) => (
                <Select
                  id={id}
                  className="w-full"
                  disabled={loading}
                  value={String(slots.styleSlot)}
                  options={slotOptions("styles")}
                  onValueChange={(value) => {
                    controller.update("start", { styleSlot: Number(value) });
                  }}
                />
              )}
            </Field>
          </div>
        )}

        <Field
          label="Product links"
          aside={
            loading ? <Spinner size={11} label="Loading what was used last time" /> : "Optional"
          }
          hint="One link per line."
          error={linksError}
        >
          {(id, describedBy) => (
            <Textarea
              ref={linksRef}
              // Focus the first field on open, also when a warning comes first.
              autoFocus
              id={id}
              aria-describedby={describedBy}
              mono
              rows={3}
              wrap="off"
              placeholder="https://"
              invalid={linksError !== null}
              value={dialog.productLinks}
              onChange={(event) => {
                controller.update("start", { productLinks: event.target.value });
              }}
            />
          )}
        </Field>

        <Field
          label="Notes"
          aside="Optional"
          hint={
            dialog.prefill === "error"
              ? "What was used last time could not be loaded."
              : `Anything ${agent} should know about this video.`
          }
        >
          {(id, describedBy) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              placeholder="For example: mention the launch discount in the first minute."
              value={dialog.notes}
              onChange={(event) => {
                controller.update("start", { notes: event.target.value });
              }}
            />
          )}
        </Field>

        <UrgentField
          checked={dialog.urgent}
          disabled={dialog.submitting}
          onChange={(urgent) => {
            controller.update("start", { urgent });
          }}
        />
      </form>
    </Sheet>
  );
}
