import { FileVideo, RefreshCw, TriangleAlert } from "lucide-react";
import { useId, useRef } from "react";
import { Field, Sheet, Textarea } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { programName } from "@/lib/readiness";
import { Callout } from "./Callout";
import type { ReEditDialog } from "./controller";
import { useJobsEnv } from "./env";
import { useLiveVideo } from "./hooks";
import { SheetFooter } from "./SheetFooter";
import { UrgentField } from "./UrgentField";
import { useSubmitShortcut } from "./useSubmitShortcut";
import { changesProblem } from "./validation";

/** Re-Edit (SPEC sections 8 and 16): one required text area with the changes, and Urgent. */
export function ReEditSheet({ dialog }: { dialog: ReEditDialog }) {
  const { controller } = useJobsEnv();
  const formId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const video = useLiveVideo(dialog.video);
  const program = useAppState((s) => s.harness.data?.program);
  const error = dialog.showErrors ? changesProblem(dialog.changes) : null;

  const submit = () => {
    if (changesProblem(dialog.changes)) fieldRef.current?.focus();
    void controller.submitReEdit();
  };
  useSubmitShortcut(submit);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
      dismissible={!dialog.submitting}
      title="Re-Edit"
      description={<span dir="auto">{video.folderName}</span>}
      footer={
        <SheetFooter
          form={formId}
          submitLabel="Re-Edit"
          shortcutHint="to re-edit"
          submitIcon={<RefreshCw />}
          submitting={dialog.submitting}
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
        {dialog.error && (
          <Callout tone="danger" icon={<TriangleAlert />} title="Could not start the re-edit">
            {dialog.error}
          </Callout>
        )}
        {video.output.project && (
          <div className="flex items-center gap-2.5 rounded-lg border border-separator bg-subtle px-3 py-2.5">
            <FileVideo className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <p className="min-w-0 text-base text-fg-muted">
              {programName(program)} changes the project of this video. The version before stays in
              the revisions of the timeline.
            </p>
          </div>
        )}
        <Field
          label="What should change"
          hint="Be specific. Everything you do not mention stays as it is."
          error={error}
        >
          {(id, describedBy) => (
            <Textarea
              ref={fieldRef}
              id={id}
              aria-describedby={describedBy}
              aria-required
              rows={7}
              invalid={error !== null}
              placeholder="For example: shorten the intro to 10 seconds, make the price text bigger, and replace the b-roll at 2:10."
              value={dialog.changes}
              onChange={(event) => {
                controller.update("reEdit", { changes: event.target.value });
              }}
            />
          )}
        </Field>
        <UrgentField
          checked={dialog.urgent}
          disabled={dialog.submitting}
          onChange={(urgent) => {
            controller.update("reEdit", { urgent });
          }}
        />
      </form>
    </Sheet>
  );
}
