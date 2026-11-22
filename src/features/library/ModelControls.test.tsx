import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import type { HarnessPublicView } from "@/lib/types";
import { ModelControls } from "./ModelControls";

let app: TestApp;

async function setup(harness: Partial<HarnessPublicView>, options: SetupOptions = {}) {
  app = await setupApp(["default"], {
    ...options,
    prepare: (backend) => {
      backend.world.harnessPublic = { ...backend.world.harnessPublic, ...harness };
    },
  });
  app.render(<ModelControls />);
}

describe("ModelControls for a user", () => {
  it("is a read-only line with the program, the model and the effort, no button", async () => {
    await setup(
      {
        setup: "claudeSubscription",
        program: "claudeCode",
        model: "opus",
        modelName: "Opus 5.5",
        effort: "high",
      },
      { user: "user" },
    );
    const line = await screen.findByRole("group", {
      name: "New edits run with Claude Code on Claude Subscription with Opus 5.5 at High effort.",
    });
    expect(line).toHaveTextContent("Claude Code·Opus 5.5High");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains that the admin chooses it", async () => {
    const user = userEvent.setup();
    await setup({ model: "opus", modelName: "Opus 5.5" }, { user: "user" });
    await user.hover(await screen.findByRole("group"));
    expect((await screen.findAllByText(/The admin chooses it\.$/)).length).toBeGreaterThan(0);
  });

  it("says Default model on the Claude subscription without a chosen model, and no effort", async () => {
    await setup({ model: null, modelName: null, effort: null }, { user: "user" });
    const line = await screen.findByRole("group", {
      name: "New edits run with Claude Code on Claude Subscription with Default model.",
    });
    expect(line).toHaveTextContent("Claude Code·Default model");
    expect(line).not.toHaveTextContent("High");
  });

  it.each([
    ["opencodeGo", "opencode2", "GLM-5.3", "OpenCode Go", "OpenCode 2"],
    ["anthropicApi", "claudeCode", "claude-sonnet-5-5", "Anthropic Compatible API", "Claude Code"],
    ["openaiApi", "opencode2", "gpt-5.3", "OpenAI Compatible API", "OpenCode 2"],
  ] as const)(
    "names the program, service and model of %s",
    async (setupName, program, model, service, programName) => {
      await setup(
        { setup: setupName, program, model, modelName: model, effort: null },
        { user: "user" },
      );
      const line = await screen.findByRole("group", {
        name: `New edits run with ${programName} on ${service} with ${model}.`,
      });
      expect(line).toHaveTextContent(`${programName}·${model}`);
    },
  );

  it("says No model chosen on an API option without one", async () => {
    await setup(
      { setup: "openaiApi", program: "opencode2", model: null, modelName: null, effort: null },
      { user: "user" },
    );
    expect(await screen.findByRole("group")).toHaveTextContent("OpenCode 2·No model chosen");
  });

  it("follows the harness when the server announces a change", async () => {
    await setup({ model: "opus", modelName: "Opus 5.5" }, { user: "user" });
    expect(await screen.findByRole("group")).toHaveTextContent("Opus 5.5");
    act(() => {
      app.store.getState().setHarness({
        setup: "claudeSubscription",
        program: "claudeCode",
        model: "sonnet",
        modelName: "Sonnet 5.5",
        effort: "low",
      });
    });
    expect(screen.getByRole("group")).toHaveTextContent("Sonnet 5.5Low");
  });

  it("shows nothing before the harness is known", async () => {
    app = await setupApp(["default"], { user: "user", load: false });
    const { container } = app.render(<ModelControls />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ModelControls for an admin", () => {
  it("is the same line as a button that opens Admin, Harness and Model", async () => {
    const user = userEvent.setup();
    await setup({ model: "opus", modelName: "Opus 5.5", effort: "high" });
    const button = await screen.findByRole("button", {
      name: "New edits run with Claude Code on Claude Subscription with Opus 5.5 at High effort. Open Admin, Harness and Model",
    });
    expect(button).toHaveTextContent("Claude Code·Opus 5.5High");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();

    await user.hover(button);
    expect(
      (await screen.findAllByText(/Change it in Admin, Harness and Model\.$/)).length,
    ).toBeGreaterThan(0);

    await user.click(button);
    expect(app.store.getState().view).toBe("admin");
    expect(app.store.getState().adminSection).toBe("harness");
  });
});
