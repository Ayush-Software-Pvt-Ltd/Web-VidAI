/**
 * Admin, Harness and Model, "Program" (SPEC section 5): the program that does new edits on the
 * selected setup, Claude Code for options 1 and 3 or OpenCode 2 for options 2 and 4, as the
 * server found it (installed, version, location) and, for the Claude subscription, the login of
 * the server's Claude Code with the sentence the server gives. All of it is read-only: installing
 * and logging in happen on the computer that runs VidAI, which the page says plainly.
 */
import { useEffect } from "react";
import { Callout, Group, Row } from "@/features/settings";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { programOf, SETUP_INFO } from "@/lib/setup";
import type { ReadinessProblem, Setup } from "@/lib/types";
import { Located, Placeholder, Status } from "../SystemParts";

/** The problems of the selected setup that the cards above do not already say. */
const PROGRAM_PROBLEMS: ReadonlySet<ReadinessProblem> = new Set([
  "claudeMissing",
  "claudeLoggedOut",
  "programMissing",
  "programUnsupported",
  "gitBashMissing",
  "notPrepared",
]);

export function ProgramGroup({ setup }: { setup: Setup }) {
  const store = useAppStoreApi();
  const system = useAppState((s) => s.adminSystem);
  const readiness = useAppState((s) => s.readiness.data);
  useEffect(() => {
    if (system.status === "idle") void store.getState().loadAdminSystem();
  }, [system.status, store]);

  const harness = programOf(setup);
  const programName = SETUP_INFO[setup].programName;
  const program = system.data?.programs.find(
    (p) => p.id === (harness === "claudeCode" ? "claude" : "opencode"),
  );
  const problem = readiness?.problem ?? null;
  const showsProblem = problem !== null && PROGRAM_PROBLEMS.has(problem);
  const loggedOut = problem === "claudeLoggedOut";

  return (
    <Group
      title="Program"
      description={`New edits run with ${programName} on the computer that runs VidAI.`}
    >
      <Row
        label={programName}
        description={
          program?.found && program.path ? (
            <Located
              lead={program.version ? `Version ${program.version}` : "Version unknown"}
              path={program.path}
            />
          ) : (
            (program?.note ?? `VidAI starts ${programName} on the computer that runs VidAI.`)
          )
        }
        control={
          program ? (
            <Status ok={program.found}>{program.found ? "Installed" : "Not installed"}</Status>
          ) : system.error ? (
            <Status ok={false}>Not checked</Status>
          ) : (
            <Placeholder />
          )
        }
      >
        {system.error && !program && (
          <Callout tone="danger" live title="Could not check the server">
            {system.error.message}
          </Callout>
        )}
        {program && !program.found && (
          <Callout tone="warning" title={`${programName} is not installed`}>
            Installing it happens on the computer that runs VidAI. See Admin, System for what the
            server found.
          </Callout>
        )}
      </Row>
      {setup === "claudeSubscription" && (
        <Row
          label="Claude login"
          description="The Claude Code of the computer that runs VidAI is logged in once, there. Logging in cannot be done from this page: run claude in a terminal on that computer and sign in."
          control={
            readiness === null ? (
              <Placeholder />
            ) : problem === "claudeMissing" ? (
              <Status ok={false} needed={false}>
                Unknown
              </Status>
            ) : (
              <Status ok={!loggedOut}>{loggedOut ? "Not logged in" : "Logged in"}</Status>
            )
          }
        />
      )}
      {showsProblem && readiness?.message && (
        <div className="px-4 py-3">
          <Callout tone="warning" live title="New edits cannot start yet">
            {readiness.message}
          </Callout>
        </div>
      )}
    </Group>
  );
}
