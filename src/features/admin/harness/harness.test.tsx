/**
 * Admin, Harness and Model (SPEC sections 5 and 16): the four options as radio cards, selecting
 * one (the toast, a refused choice put back, why an API card is disabled), the Configure toggles,
 * the Claude model of the subscription, the note about Claude Code pointed elsewhere and what a
 * non-admin gets. Everything is read back from `world.harness` and `harnessSim(world).keys`.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getToasts } from "@/components/ui/toastStore";
import type { MockBackend, ScenarioName } from "@/lib/mock";
import {
  harnessSim,
  putKey,
  SAMPLE_ANTHROPIC_MODEL,
  SAMPLE_OPENAI_MODEL,
  SAMPLE_OPENCODE_KEY,
  SAMPLE_OPENCODE_MODEL,
  syncHarness,
} from "@/lib/mock/seed/harness";
import { noModelText, SETUP_INFO, SETUPS } from "@/lib/setup";
import { renderApp, type SetupOptions } from "@/test/app";
import { NEW_EDITS_NOTE } from "./ClaudeModelGroup";
import { HarnessPage } from "./HarnessPage";
import { SETUP_KEPT_NOTE } from "./SetupGroup";

async function setup(scenarios?: ScenarioName[], options?: SetupOptions) {
  const app = await renderApp(<HarnessPage />, scenarios, options);
  return { user: userEvent.setup(), ...app };
}

/** All three API options can run an edit: Go has its key and model, the others a typed model. */
const allReady = (backend: MockBackend) => {
  const { world } = backend;
  putKey(world, "opencodeGo", SAMPLE_OPENCODE_KEY);
  world.harness.options.opencodeGo.model = SAMPLE_OPENCODE_MODEL;
  world.harness.options.anthropicApi.model = SAMPLE_ANTHROPIC_MODEL;
  world.harness.options.openaiApi.model = SAMPLE_OPENAI_MODEL;
  syncHarness(world);
};

const radio = (setupId: (typeof SETUPS)[number]) =>
  screen.getByRole("radio", { name: SETUP_INFO[setupId].label });
const panel = (setupId: (typeof SETUPS)[number]) =>
  screen.queryByRole("group", { name: `Settings of ${SETUP_INFO[setupId].label}` });
const openPanel = (setupId: (typeof SETUPS)[number]) =>
  screen.getByRole("group", { name: `Settings of ${SETUP_INFO[setupId].label}` });
const lastToast = () => getToasts().at(-1);

describe("The page", () => {
  it("lists the four options with their line, the selected one marked", async () => {
    await setup();
    expect(
      await screen.findByRole("radiogroup", { name: "How should VidAI run edits?" }),
    ).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    for (const id of SETUPS) {
      expect(radio(id)).toBeInTheDocument();
      expect(screen.getByText(SETUP_INFO[id].line)).toBeInTheDocument();
    }
    expect(radio("claudeSubscription")).toBeChecked();
    expect(screen.getByText("Used for new edits")).toBeInTheDocument();
    expect(screen.getByText(SETUP_KEPT_NOTE)).toBeInTheDocument();
    expect(SETUP_KEPT_NOTE).toMatch(/stay on the setup their session started on/);
  });

  it("shows the state the server holds, not a copy: the option another admin chose", async () => {
    await setup(["setup-anthropic-api"]);
    expect(await screen.findByRole("radio", { name: SETUP_INFO.anthropicApi.label })).toBeChecked();
    expect(radio("claudeSubscription")).not.toBeChecked();
    expect(panel("anthropicApi")).toBeInTheDocument();
  });

  it("says why an API option cannot be selected yet, and asks for a key only on OpenCode Go", async () => {
    const { user, backend } = await setup();
    await screen.findByRole("radiogroup");
    for (const id of ["opencodeGo", "anthropicApi", "openaiApi"] as const) {
      expect(radio(id)).toBeDisabled();
    }
    // Only OpenCode Go needs a key; the other two wait for a typed model alone.
    expect(screen.getAllByText("Save an API key first.")).toHaveLength(1);
    expect(screen.getAllByText("Type a model first.")).toHaveLength(2);

    // Anthropic compatible: no key is asked for, and saving one changes nothing about the reason.
    await user.click(
      screen.getByRole("button", { name: `Configure ${SETUP_INFO.anthropicApi.label}` }),
    );
    const form = within(openPanel("anthropicApi"));
    expect(form.getByLabelText("API Key (optional)")).toBeInTheDocument();
    expect(form.queryByText("Save an API key first.")).not.toBeInTheDocument();
    await user.type(form.getByLabelText("API Key (optional)"), "sk-ant-test-0000aaaa1111");
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(await form.findByText(/^Saved, ends in /)).toBeInTheDocument();
    // A typed model: the card asks to type it, not to choose it from a list.
    expect(screen.getAllByText("Type a model first.")).toHaveLength(2);
    expect(screen.queryByText("Choose a model first.")).not.toBeInTheDocument();
    expect(radio("anthropicApi")).toBeDisabled();
    // OpenCode Go's key is required, then its model is chosen from its list.
    await user.click(
      screen.getByRole("button", { name: `Configure ${SETUP_INFO.opencodeGo.label}` }),
    );
    const go = within(openPanel("opencodeGo"));
    expect(go.getByLabelText("API Key")).toBeInTheDocument();
    expect(radio("opencodeGo")).toBeDisabled();
    await user.type(go.getByLabelText("API Key"), "oc_sk_test-0000aaaa1111");
    await user.click(go.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose a model first.")).toBeInTheDocument();
    expect(screen.queryByText("Save an API key first.")).not.toBeInTheDocument();
    // The key is saved on the server (encrypted there), never shown again.
    expect(harnessSim(backend.world).keys.opencodeGo).toBe("oc_sk_test-0000aaaa1111");
    expect(backend.world.harness.options.opencodeGo.key).toEqual({ saved: true, last4: "1111" });
    expect(screen.queryByText(/oc_sk_test/)).not.toBeInTheDocument();
  });

  it("selects an option in one change, with a toast, and the program row follows", async () => {
    const { user, backend } = await setup(["setup-ready"], { prepare: allReady });
    await waitFor(() => {
      expect(radio("opencodeGo")).toBeEnabled();
    });
    expect(screen.getByRole("region", { name: "Program" })).toHaveTextContent("Claude Code");
    await user.click(radio("opencodeGo"));
    await waitFor(() => {
      expect(radio("opencodeGo")).toBeChecked();
    });
    expect(backend.world.harness.setup).toBe("opencodeGo");
    expect(backend.world.harness.program).toBe("opencode2");
    expect(lastToast()).toMatchObject({
      tone: "success",
      title: "New edits run with OpenCode 2 on OpenCode Go",
    });
    expect(lastToast()?.description).toMatch(/keep the setup they started on/);
    expect(screen.getByRole("region", { name: "Program" })).toHaveTextContent("OpenCode 2");
    // Back to the subscription.
    await user.click(radio("claudeSubscription"));
    await waitFor(() => {
      expect(backend.world.harness.setup).toBe("claudeSubscription");
    });
    expect(lastToast()).toMatchObject({
      title: "New edits run with Claude Code on Claude Subscription",
    });
  });

  it("tells everybody: the public setup follows the choice", async () => {
    const { user, backend } = await setup(["setup-ready"], { prepare: allReady });
    await waitFor(() => {
      expect(radio("openaiApi")).toBeEnabled();
    });
    await user.click(radio("openaiApi"));
    await waitFor(() => {
      expect(radio("openaiApi")).toBeChecked();
    });
    expect(backend.world.adminSettings.setup).toBe("openaiApi");
    expect(backend.world.harnessPublic).toMatchObject({
      setup: "openaiApi",
      model: SAMPLE_OPENAI_MODEL,
    });
  });

  it("puts the saved choice back when the server refuses", async () => {
    const { user, backend } = await setup(["setup-ready"], { prepare: allReady });
    await waitFor(() => {
      expect(radio("openaiApi")).toBeEnabled();
    });
    // Another admin removed the model meanwhile: this page still shows the card as usable.
    backend.world.harness.options.openaiApi.model = null;
    await user.click(radio("openaiApi"));
    await waitFor(() => {
      expect(lastToast()).toMatchObject({
        tone: "error",
        title: "The setup was not changed",
        description: noModelText("openaiApi"),
      });
    });
    expect(radio("claudeSubscription")).toBeChecked();
    expect(radio("openaiApi")).not.toBeChecked();
    expect(backend.world.harness.setup).toBe("claudeSubscription");
  });

  it("goes back to Claude Code with Claude Subscription when the key of OpenCode Go is removed", async () => {
    const { user, backend } = await setup(["setup-opencode-go"]);
    await waitFor(() => {
      expect(radio("opencodeGo")).toBeChecked();
    });
    await user.click(
      await within(openPanel("opencodeGo")).findByRole("button", { name: "Remove…" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove Key" }),
    );
    await waitFor(() => {
      expect(radio("claudeSubscription")).toBeChecked();
    });
    expect(harnessSim(backend.world).keys.opencodeGo).toBeNull();
    expect(backend.world.harness.setup).toBe("claudeSubscription");
    expect(radio("opencodeGo")).toBeDisabled();
  });

  it.each([
    ["setup-anthropic-api", "anthropicApi"],
    ["setup-openai-api", "openaiApi"],
  ] as const)(
    "keeps %s selected when its key is removed, because that option needs no key",
    async (scenario, option) => {
      const { user, backend } = await setup([scenario], {
        // The OpenAI scenario runs without a key: save one so there is one to remove.
        prepare: (b) => {
          if (option === "openaiApi") putKey(b.world, option, "sk-test-0000aaaa1111");
        },
      });
      await waitFor(() => {
        expect(radio(option)).toBeChecked();
      });
      await user.click(await within(openPanel(option)).findByRole("button", { name: "Remove…" }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove Key" }),
      );
      await waitFor(() => {
        expect(harnessSim(backend.world).keys[option]).toBeNull();
      });
      expect(await screen.findByText(/No key saved\. Leave it empty/)).toBeInTheDocument();
      expect(radio(option)).toBeChecked();
      expect(radio(option)).toBeEnabled();
      expect(radio("claudeSubscription")).not.toBeChecked();
      expect(backend.world.harness.setup).toBe(option);
    },
  );
});

describe("Configure", () => {
  it("opens the settings of the selected option, and of any other on request", async () => {
    const { user } = await setup(["setup-opencode-go"]);
    await waitFor(() => {
      expect(panel("opencodeGo")).toBeInTheDocument();
    });
    expect(panel("anthropicApi")).not.toBeInTheDocument();
    expect(panel("claudeSubscription")).not.toBeInTheDocument();
    // Claude Code with the subscription has nothing to configure here.
    expect(
      screen.queryByRole("button", { name: `Configure ${SETUP_INFO.claudeSubscription.label}` }),
    ).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: `Configure ${SETUP_INFO.anthropicApi.label}`,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel("anthropicApi")).toBeInTheDocument();
    // One panel never replaces another: the selected one stays open.
    expect(panel("opencodeGo")).toBeInTheDocument();
    await user.click(toggle);
    expect(panel("anthropicApi")).not.toBeInTheDocument();
  });

  it("lets an option be configured before it is selected", async () => {
    const { user, backend } = await setup();
    await user.click(
      await screen.findByRole("button", { name: `Configure ${SETUP_INFO.openaiApi.label}` }),
    );
    const form = within(openPanel("openaiApi"));
    // No key: the model alone makes the option ready.
    await user.type(await form.findByRole("textbox", { name: "Model" }), "kimi-k3{Enter}");
    await waitFor(() => {
      expect(radio("openaiApi")).toBeEnabled();
    });
    expect(harnessSim(backend.world).keys.openaiApi).toBeNull();
    await user.click(radio("openaiApi"));
    await waitFor(() => {
      expect(backend.world.harness.setup).toBe("openaiApi");
    });
  });

  it("lets OpenCode Go be configured before it is selected, once its key and model are saved", async () => {
    const { user, backend } = await setup();
    await user.click(
      await screen.findByRole("button", { name: `Configure ${SETUP_INFO.opencodeGo.label}` }),
    );
    const form = within(openPanel("opencodeGo"));
    await user.type(form.getByLabelText("API Key"), "oc_sk_live_0123456789ab");
    await user.click(form.getByRole("button", { name: "Save" }));
    await user.click(await form.findByRole("button", { name: "Model" }));
    const list = await screen.findByRole("dialog", { name: "Models" });
    await user.click(await within(list).findByRole("option", { name: "GLM-5.2 (glm-5.2)" }));
    await waitFor(() => {
      expect(radio("opencodeGo")).toBeEnabled();
    });
    await user.click(radio("opencodeGo"));
    await waitFor(() => {
      expect(backend.world.harness.setup).toBe("opencodeGo");
    });
    expect(backend.world.harness.options.opencodeGo.model).toBe("glm-5.2");
  });
});

describe("Claude model", () => {
  const group = () => screen.getByRole("region", { name: "Claude model" });
  const pick = async (
    user: ReturnType<typeof userEvent.setup>,
    name: "Model" | "Reasoning effort",
    option: string,
  ) => {
    await user.click(within(group()).getByRole("combobox", { name }));
    await user.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
  };

  it("shows Claude Code's own default, the note, and what the server holds", async () => {
    await setup(["setup-ready"]);
    await screen.findByRole("region", { name: "Claude model" });
    expect(group()).toHaveTextContent(
      "Used when edits run on Claude Code with the Claude subscription.",
    );
    expect(group()).toHaveTextContent(NEW_EDITS_NOTE);
    expect(NEW_EDITS_NOTE).toMatch(/already runs keeps the model and effort it started with/);
    await waitFor(() => {
      expect(within(group()).getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "Sonnet 5.5",
      );
    });
    expect(within(group()).getByRole("combobox", { name: "Reasoning effort" })).toHaveTextContent(
      "High",
    );
  });

  it("saves a model and an effort at once, and offers only the efforts the model supports", async () => {
    const { user, backend } = await setup();
    await screen.findByRole("region", { name: "Claude model" });
    expect(within(group()).getByRole("combobox", { name: "Model" })).toHaveTextContent("Default");
    await pick(user, "Model", "Sonnet 5.5");
    await waitFor(() => {
      expect(backend.world.harness.claude.model).toBe("claude-sonnet-5-5");
    });
    await user.click(within(group()).getByRole("combobox", { name: "Reasoning effort" }));
    // Sonnet has three levels, not the five of Opus.
    expect(await screen.findAllByRole("option")).toHaveLength(4);
    expect(screen.queryByRole("option", { name: "Max" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Medium" }));
    await waitFor(() => {
      expect(backend.world.harness.claude.effort).toBe("medium");
    });
    expect(backend.world.harnessPublic).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
  });

  it("drops an effort the new model does not have, and a model with none has no choice", async () => {
    const { user, backend } = await setup(["setup-ready"]);
    await waitFor(() => {
      expect(within(group()).getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "Sonnet 5.5",
      );
    });
    await pick(user, "Model", "Haiku 5.5");
    await waitFor(() => {
      expect(backend.world.harness.claude.model).toBe("claude-haiku-5-5");
    });
    expect(backend.world.harness.claude.effort).toBeNull();
    expect(within(group()).getByRole("combobox", { name: "Reasoning effort" })).toBeDisabled();
    expect(group()).toHaveTextContent("Haiku 5.5 has no reasoning effort to choose.");
    // Back to Default: any level is allowed again.
    await pick(user, "Model", "Default");
    await waitFor(() => {
      expect(backend.world.harness.claude.model).toBeNull();
    });
    expect(within(group()).getByRole("combobox", { name: "Reasoning effort" })).toBeEnabled();
  });

  it("keeps an effort the new model also has", async () => {
    const { user, backend } = await setup(["setup-ready"]);
    await waitFor(() => {
      expect(within(group()).getByRole("combobox", { name: "Reasoning effort" })).toHaveTextContent(
        "High",
      );
    });
    await pick(user, "Model", "Opus 5.5");
    await waitFor(() => {
      expect(backend.world.harness.claude.model).toBe("claude-opus-5-5");
    });
    expect(backend.world.harness.claude.effort).toBe("high");
  });
});

describe("Claude Code pointed elsewhere", () => {
  it("is said under the Claude subscription", async () => {
    await setup(["claude-routed"]);
    const title = await screen.findByText("Claude Code is pointed at another service");
    const note = title.parentElement as HTMLElement;
    expect(note).toHaveTextContent("https://gateway.example.com");
    expect(note).toHaveTextContent(
      "ANTHROPIC_BASE_URL in the environment of the computer that runs VidAI",
    );
    expect(note).toHaveTextContent("not to your Claude plan");
  });

  it("names the settings file when that is where it is set, and warns the Anthropic API about it", async () => {
    await setup(["setup-anthropic-api", "claude-routed"], {
      prepare: (b) => {
        b.world.harness.claudeRouting = {
          baseUrl: "https://llm-proxy.example.com/anthropic",
          source: "claudeSettings",
        };
      },
    });
    const note = (await screen.findByText("Claude Code is pointed at another service"))
      .parentElement as HTMLElement;
    expect(note).toHaveTextContent("https://llm-proxy.example.com/anthropic");
    expect(note).toHaveTextContent(
      "env of the Claude Code settings file on the computer that runs VidAI",
    );
    expect(note).toHaveTextContent("may not reach it either");
  });

  it("is not there without such a setup", async () => {
    await setup();
    await screen.findByRole("radiogroup");
    expect(screen.queryByText("Claude Code is pointed at another service")).not.toBeInTheDocument();
  });
});

describe("Who may see it", () => {
  it("shows a user the server's refusal instead of the settings", async () => {
    await setup(undefined, { user: "user" });
    expect(await screen.findByText("Harness and Model could not be loaded")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});
