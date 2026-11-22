/**
 * Admin, System (SPEC sections 5 and 7): what the server found on its computer, with a state and
 * a hint for each (the server itself, its programs, the toolkit, the processor and graphics card
 * limits in force) and Prepare, which sets up the toolkit step by step. Everything is read from
 * `adminGetSystem`; the store reloads it when the server says `system-changed`, so the steps move
 * live. Prepare is one press; it cannot be pressed again while it runs.
 */
import { CircleCheck, CircleDashed, CircleX, Play } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, CopyButton, EmptyState, PathText, Spinner } from "@/components/ui";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { formatBytes, formatDuration, formatLocalDateTime, formatTimeAgo } from "@/lib/format";
import { programOf, SETUP_INFO } from "@/lib/setup";
import type {
  PrepareState,
  PrepareStep,
  ProgramInfo,
  Setup,
  SystemGpuSlot,
  SystemView,
} from "@/lib/types";
import { Callout, Group, Row, SettingsPage, useAction } from "@/features/settings";
import { Located, Placeholder, Status } from "./SystemParts";

export function SystemPage() {
  const store = useAppStoreApi();
  const { data, status, error } = useAppState((s) => s.adminSystem);
  useEffect(() => {
    if (status === "idle") void store.getState().loadAdminSystem();
  }, [status, store]);

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        {status === "error" && error ? (
          <EmptyState
            tone="error"
            title="The System page could not be loaded"
            description={error.message}
            action={
              <Button
                onClick={() => {
                  void store.getState().loadAdminSystem();
                }}
              >
                Try Again
              </Button>
            }
          />
        ) : (
          <Spinner label="Loading System" />
        )}
      </div>
    );
  }

  return (
    <SettingsPage>
      <ServerGroup system={data} />
      <ProgramsGroup programs={data.programs} />
      <ToolkitGroup toolkit={data.toolkit} />
      <PrepareGroup prepare={data.prepare} installError={data.toolkit.installError} />
      <LimitsGroup cpu={data.cpu} gpu={data.gpu} />
    </SettingsPage>
  );
}

/** A path or address with its Copy button, for a row whose value is long. */
function CopyLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <PathText path={text} className="text-fg" />
      </div>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function ServerGroup({ system }: { system: SystemView }) {
  const { server, dataDir, addresses } = system;
  const free =
    dataDir.freeBytes !== null && dataDir.totalBytes !== null
      ? `${formatBytes(dataDir.freeBytes)} free of ${formatBytes(dataDir.totalBytes)}`
      : null;
  return (
    <Group
      title="This server"
      description="The computer that runs VidAI and what it knows about itself."
    >
      <Row
        label="Version"
        description={`Running since ${formatLocalDateTime(server.startedAt)}.`}
        control={<span className="text-base text-fg">{server.version}</span>}
      />
      <Row
        label="Computer"
        description={`${server.os}, Node.js ${server.node}`}
        control={<span className="text-base text-fg">{server.hostname}</span>}
      />
      <Row
        label={addresses.length === 1 ? "Address" : "Addresses"}
        description={
          addresses.length === 0
            ? "The server does not know an address it can be reached at."
            : "Users open VidAI at one of these."
        }
      >
        {addresses.map((address) => (
          <CopyLine key={address} text={address} label={`Copy ${address}`} />
        ))}
      </Row>
      <Row
        label="Data folder"
        description="Where VidAI keeps its database, the toolkit and the media of every channel that has no folder of its own."
      >
        <CopyLine text={dataDir.path} label="Copy the data folder path" />
        <p className="text-sm text-fg-muted">
          {free ?? "The free space of its disk could not be read."}
        </p>
      </Row>
    </Group>
  );
}

/** Whether new edits need this program on the selected setup (a miss of another one is quiet). */
function needed(id: string, setup: Setup | null): boolean {
  if (setup === null) return true;
  if (id === "claude") return programOf(setup) === "claudeCode";
  if (id === "opencode") return programOf(setup) === "opencode2";
  return true;
}

function ProgramsGroup({ programs }: { programs: ProgramInfo[] }) {
  const setup = useAppState((s) => s.harness.data?.setup ?? null);
  const readiness = useAppState((s) => s.readiness.data);
  const info = setup === null ? null : SETUP_INFO[setup];
  return (
    <Group
      title="Programs"
      description="What the server found and uses. Installing or logging in happens on the computer that runs VidAI, then press Prepare."
    >
      {programs.map((program) => {
        const isNeeded = needed(program.id, setup);
        const quiet = !program.found && !isNeeded;
        return (
          <Row
            key={program.id}
            label={program.label}
            description={
              <>
                {program.found && program.path ? (
                  <Located
                    lead={program.version ? `Version ${program.version}` : "Version unknown"}
                    path={program.path}
                  />
                ) : (
                  <span>{program.note ?? "Not found."}</span>
                )}
                {program.found && program.note && <span className="block">{program.note}</span>}
                {quiet && info && (
                  <span className="block">
                    Not needed while new edits run with {info.programName}.
                  </span>
                )}
              </>
            }
            control={
              <Status ok={program.found} needed={isNeeded}>
                {program.found ? "Found" : "Not found"}
              </Status>
            }
          />
        );
      })}
      {programs.some((p) => p.id === "claude" && p.found) && (
        <Row
          label="Claude login"
          description={
            setup === "claudeSubscription"
              ? "The Claude Code of this computer is logged in once, there: run claude in a terminal on it and sign in."
              : "Only edits on the Claude subscription need a login."
          }
          control={
            readiness === null ? (
              <Placeholder />
            ) : setup !== "claudeSubscription" ? (
              <Status ok={false} needed={false}>
                Not needed
              </Status>
            ) : readiness.problem === "claudeLoggedOut" ? (
              <Status ok={false}>Not logged in</Status>
            ) : (
              <Status ok>Logged in</Status>
            )
          }
        />
      )}
    </Group>
  );
}

function ToolkitGroup({ toolkit }: { toolkit: SystemView["toolkit"] }) {
  const installed = toolkit.installedVersion;
  const versionLine =
    installed === null
      ? "The toolkit is not installed."
      : toolkit.upToDate
        ? `Version ${installed}, the one this server ships.`
        : toolkit.shippedVersion === null
          ? `Version ${installed}. The shipped toolkit could not be read.`
          : `Version ${installed}. This server ships version ${toolkit.shippedVersion}.`;
  return (
    <Group
      title="Toolkit"
      description="The programs and the Python environment the agents edit with. One copy for the whole server."
      footer={
        toolkit.hasPrevious
          ? "The toolkit that was replaced by the last upgrade is kept once, next to it, as CLAUDE_VE_ALL.previous."
          : undefined
      }
    >
      <Row
        label="Toolkit"
        description={versionLine}
        control={
          <Status ok={installed !== null && toolkit.upToDate}>
            {installed === null
              ? "Not installed"
              : toolkit.upToDate
                ? "Up to date"
                : "Needs an upgrade"}
          </Status>
        }
      >
        {toolkit.installError && (
          <Callout tone="danger" title="The toolkit could not be installed">
            {toolkit.installError}
          </Callout>
        )}
      </Row>
      <Row label="Folder">
        <CopyLine text={toolkit.folder} label="Copy the toolkit folder path" />
      </Row>
      <Row label="Python environment" description="The Python the agents run the toolkit with.">
        <CopyLine text={toolkit.python} label="Copy the Python path" />
      </Row>
    </Group>
  );
}

const STEP_WORD: Record<PrepareStep["state"], string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

function StepMark({ state }: { state: PrepareStep["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-base [&_svg]:size-4",
        state === "failed" ? "text-danger" : state === "pending" ? "text-fg-muted" : "text-fg",
      )}
    >
      {state === "done" ? (
        <CircleCheck className="text-success" />
      ) : state === "failed" ? (
        <CircleX />
      ) : state === "running" ? (
        <Spinner size={16} />
      ) : (
        <CircleDashed />
      )}
      {STEP_WORD[state]}
    </span>
  );
}

/** What a step that is not done holds back, in the words of SPEC section 7. */
const HOLDS_BACK = {
  editing: "Edits cannot start until this step is done.",
  rendering: "Render Final cannot run until this step is done.",
} as const;

function stepHint(step: PrepareStep): string | null {
  if (step.state === "done") return null;
  return HOLDS_BACK[step.blocks];
}

function PrepareSummary({ prepare }: { prepare: PrepareState }) {
  const failed = prepare.steps.find((s) => s.state === "failed");
  if (prepare.running) {
    return (
      <Callout tone="info" live title="Prepare is running">
        Edits cannot start while it runs. The steps below show how far it is.
      </Callout>
    );
  }
  if (failed) {
    return (
      <Callout tone="danger" live title={`${failed.label} failed`}>
        {failed.message ?? "The step did not finish."} {HOLDS_BACK[failed.blocks]} Fix it, then
        press Prepare again.
      </Callout>
    );
  }
  if (!prepare.editReady) {
    return (
      <Callout tone="warning" title="Edits cannot start yet">
        {prepare.reason ? `${prepare.reason} ` : ""}Edits need every step up to the speech model.
        Press Prepare.
      </Callout>
    );
  }
  if (!prepare.renderReady) {
    return (
      <Callout tone="warning" title="Edits can start, Render Final cannot yet">
        Render Final also needs the renderer browser and the test render. Press Prepare.
      </Callout>
    );
  }
  return (
    <Callout tone="success" title="Everything is prepared">
      Edits and Render Final can start.
    </Callout>
  );
}

function PrepareGroup({
  prepare,
  installError,
}: {
  prepare: PrepareState;
  installError: string | null;
}) {
  const api = useApi();
  const store = useAppStoreApi();
  const start = useAction(async () => {
    await api.adminPrepareToolkit();
    await store.getState().loadAdminSystem();
  });
  const busy = prepare.running || start.pending;
  const logRef = useRef<HTMLPreElement>(null);
  const lines = prepare.log.length;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Group
      title="Prepare"
      description={
        prepare.finishedAt !== null
          ? `Last finished ${formatTimeAgo(prepare.finishedAt)}. Prepare also starts by itself when the server starts and edits could not start otherwise.`
          : "Sets up the toolkit's Python environment, the speech model and the renderer. It also starts by itself when the server starts and edits could not start otherwise."
      }
      aside={
        <Button
          variant="primary"
          icon={<Play />}
          loading={busy}
          disabled={busy || installError !== null}
          onClick={() => void start.run()}
        >
          Prepare
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        <PrepareSummary prepare={prepare} />
        {start.error && (
          <Callout tone="danger" live title="Prepare was not started">
            {start.error.message}
          </Callout>
        )}
      </div>
      <ol aria-label="Prepare steps" className="flex flex-col divide-y divide-separator">
        {prepare.steps.map((step) => {
          const hint = stepHint(step);
          return (
            <li key={step.id} data-testid="prepare-step" data-state={step.state}>
              <Row
                label={step.label}
                description={
                  <>
                    {step.message && (
                      <span
                        className={cn(
                          "block whitespace-pre-line",
                          step.state === "failed" && "text-danger",
                        )}
                      >
                        {step.message}
                      </span>
                    )}
                    {hint && <span className="block">{hint}</span>}
                  </>
                }
                control={<StepMark state={step.state} />}
              />
            </li>
          );
        })}
      </ol>
      <Row label="Log" description="The last lines of what the steps printed.">
        <pre
          ref={logRef}
          role="log"
          aria-label="Prepare log"
          tabIndex={0}
          className="max-h-56 overflow-auto rounded-md border border-border-container bg-subtle p-3 font-mono text-xs break-words whitespace-pre-wrap text-fg select-text"
        >
          {lines === 0 ? "Nothing has been printed yet." : prepare.log.join("\n")}
        </pre>
      </Row>
    </Group>
  );
}

function slotLine(slot: SystemGpuSlot): string {
  const what =
    slot.state === "held"
      ? "in use"
      : slot.state === "expired"
        ? "held for too long"
        : slot.state === "holder gone"
          ? "its job is gone"
          : "could not be read";
  return `Slot ${String(slot.index + 1)}: ${what}${slot.jobId ? `, job ${slot.jobId}` : ""}, taken ${formatDuration(slot.ageMs)} ago`;
}

function LimitsGroup({ cpu, gpu }: { cpu: SystemView["cpu"]; gpu: SystemView["gpu"] }) {
  return (
    <Group
      title="Limits in force"
      description="What the limits of Admin, Queues and Limits come to on this computer."
    >
      <Row
        label="Processors"
        description={`${String(cpu.running)} ${cpu.running === 1 ? "job runs" : "jobs run"} now and may use ${String(cpu.budget)} of the ${String(cpu.processors)} processors together.`}
        control={<span className="text-base text-fg">{cpu.processors}</span>}
      />
      <Row
        label="Graphics card"
        description={
          gpu.total === 0
            ? "No graphics card slot is counted on this computer."
            : `${String(gpu.slots.length)} of ${String(gpu.total)} slots taken, ${String(gpu.perJob)} per job.`
        }
        control={<span className="text-base text-fg">{gpu.total}</span>}
      >
        {gpu.slots.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-sm text-fg-muted">
            {gpu.slots.map((slot) => (
              <li key={slot.index}>{slotLine(slot)}</li>
            ))}
          </ul>
        )}
      </Row>
    </Group>
  );
}
