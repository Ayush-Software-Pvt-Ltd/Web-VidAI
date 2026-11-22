/**
 * Admin, Harness and Model (SPEC sections 5 and 16): the one place that says how edits run for
 * everybody. The four options as radio cards with the settings of each API option under its card,
 * the model of the Claude subscription, and the program of the selected one as the server found
 * it. The state is the admin's own (`adminGetHarness`); the keys are write-only.
 */
import { EmptyState, Spinner } from "@/components/ui";
import { SettingsPage } from "@/features/settings";
import { useAppState } from "@/lib/appEnv";
import { ClaudeModelGroup } from "./ClaudeModelGroup";
import { ProgramGroup } from "./ProgramGroup";
import { SetupGroup } from "./SetupGroup";
import { useHarnessState } from "./useApiOption";

export function HarnessPage() {
  const harness = useHarnessState();
  const { status, error } = useAppState((s) => s.adminHarness);

  if (!harness) {
    return (
      <div className="flex h-full items-center justify-center">
        {status === "error" && error ? (
          <EmptyState
            tone="error"
            title="Harness and Model could not be loaded"
            description={error.message}
          />
        ) : (
          <Spinner label="Loading Harness and Model" />
        )}
      </div>
    );
  }

  return (
    <SettingsPage>
      <SetupGroup />
      <ClaudeModelGroup />
      <ProgramGroup setup={harness.setup} />
    </SettingsPage>
  );
}
