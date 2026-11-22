/**
 * The form of one API option (SPEC sections 5 and 16), for each of the three options: the API
 * URL (default, saved on Return or blur, Reset to Default, refused), the API Key (save, hint,
 * remove), the model (OpenCode Go: its searchable list; the other two options: a text box and
 * Fetch Models, with no request to the service until it is pressed), the reasoning effort per
 * model and Test. Every change goes through the admin functions and is read back from
 * `world.harness`; the plaintext keys are in `harnessSim(world).keys`.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getToasts } from "@/components/ui/toastStore";
import type { MockBackend, ScenarioName } from "@/lib/mock";
import {
  harnessSim,
  putKey,
  SAMPLE_ANTHROPIC_KEY,
  SAMPLE_ANTHROPIC_MODEL,
  SAMPLE_OPENAI_KEY,
  SAMPLE_OPENAI_MODEL,
  SAMPLE_OPENCODE_KEY,
  SAMPLE_OPENCODE_MODEL,
  syncHarness,
} from "@/lib/mock/seed/harness";
import { API_DEFAULT_BASE_URL } from "@/lib/setup";
import type { ApiOption } from "@/lib/types";
import { setupApp } from "@/test/app";
import { ApiOptionForm } from "./ApiOptionForm";

interface Case {
  option: ApiOption;
  service: string;
  /** The label of the key field: only OpenCode Go needs a key, so the others say it is optional. */
  keyLabel: string;
  key: string;
  model: string;
  /** The model is typed in a box (with Fetch Models) instead of chosen from OpenCode Go's list. */
  typed: boolean;
  /** An example id the empty box shows. */
  placeholder?: string;
  /** The address an admin who set the option up has saved (the default one lists other models). */
  readyUrl?: string;
  /** What is typed into the address, and what is saved of it. */
  typedUrl: string;
  savedUrl: string;
  /** An option of the list other than the saved model, its name, id and the name Test reports. */
  pick: { name: string; id: string; shown: string };
}

const CASES: Case[] = [
  {
    option: "opencodeGo",
    service: "OpenCode Go",
    keyLabel: "API Key",
    key: SAMPLE_OPENCODE_KEY,
    model: SAMPLE_OPENCODE_MODEL,
    typed: false,
    typedUrl: "https://opencode.ai/inference/anthropic/v1/messages/",
    savedUrl: "https://opencode.ai/inference/anthropic",
    pick: { name: "Kimi K3 (kimi-k3)", id: "kimi-k3", shown: "Kimi K3" },
  },
  {
    option: "anthropicApi",
    service: "Anthropic Compatible API",
    keyLabel: "API Key (optional)",
    key: SAMPLE_ANTHROPIC_KEY,
    model: SAMPLE_ANTHROPIC_MODEL,
    typed: true,
    placeholder: "claude-sonnet-5-5",
    typedUrl: "https://gateway.example.com/v1/messages",
    savedUrl: "https://gateway.example.com",
    pick: {
      name: "Claude Haiku 5.5 (claude-haiku-5-5)",
      id: "claude-haiku-5-5",
      shown: "Claude Haiku 5.5",
    },
  },
  {
    option: "openaiApi",
    service: "OpenAI Compatible API",
    keyLabel: "API Key (optional)",
    key: SAMPLE_OPENAI_KEY,
    model: SAMPLE_OPENAI_MODEL,
    typed: true,
    placeholder: "gpt-5.3",
    readyUrl: "https://gateway.example.com/v1",
    typedUrl: "https://gateway.example.com/v1/chat/completions",
    savedUrl: "https://gateway.example.com/v1",
    pick: { name: "gpt-5.4-mini (gpt-5.4-mini)", id: "gpt-5.4-mini", shown: "gpt-5.4-mini" },
  },
];

/** The option with its key and its model saved (the Claude subscription stays selected). */
const ready = (c: Case) => (backend: MockBackend) => {
  putKey(backend.world, c.option, c.key);
  const state = backend.world.harness.options[c.option];
  state.model = c.model;
  if (c.readyUrl !== undefined) {
    state.baseUrl = c.readyUrl;
    state.effectiveBaseUrl = c.readyUrl;
  }
  syncHarness(backend.world);
};

/**
 * The form on its own: the page loads the admin's harness state, so the test does it before it
 * renders. `prepare` changes the world first.
 */
async function setup(
  c: Case,
  scenarios: ScenarioName[],
  props: { effort?: boolean; test?: boolean } = {},
  prepare?: (backend: MockBackend) => void,
) {
  const app = await setupApp(scenarios, { prepare });
  await act(async () => {
    await app.store.getState().loadAdminHarness();
  });
  app.render(<ApiOptionForm option={c.option} {...props} />);
  return { user: userEvent.setup(), ...app };
}

/** The form of an option that has its key and model, as an admin who set it up finds it. */
function setupReady(
  c: Case,
  props: { effort?: boolean; test?: boolean } = {},
  prepare?: (backend: MockBackend) => void,
  scenarios: ScenarioName[] = ["default"],
) {
  return setup(c, scenarios, props, (backend) => {
    ready(c)(backend);
    prepare?.(backend);
  });
}

describe.each(CASES)("The form of $option", (c) => {
  const saved = (backend: MockBackend) => backend.world.harness.options[c.option].baseUrl;

  describe("API URL", () => {
    it("is pre-filled with the default address and has no Reset to Default", async () => {
      await setup(c, ["default"]);
      expect(screen.getByRole("textbox", { name: "API URL" })).toHaveValue(
        API_DEFAULT_BASE_URL[c.option],
      );
      expect(screen.queryByRole("button", { name: "Reset to Default" })).not.toBeInTheDocument();
    });

    it("saves the normalized address on Return, and Reset to Default puts the default back", async () => {
      const { user, backend } = await setup(c, ["default"]);
      const field = screen.getByRole("textbox", { name: "API URL" });
      await user.clear(field);
      await user.type(field, `${c.typedUrl}{Enter}`);
      await waitFor(() => {
        expect(saved(backend)).toBe(c.savedUrl);
      });
      expect(field).toHaveValue(c.savedUrl);

      await user.click(screen.getByRole("button", { name: "Reset to Default" }));
      await waitFor(() => {
        expect(saved(backend)).toBeNull();
      });
      expect(field).toHaveValue(API_DEFAULT_BASE_URL[c.option]);
      expect(screen.queryByRole("button", { name: "Reset to Default" })).not.toBeInTheDocument();
    });

    it("saves when the field loses focus, and Esc puts back the saved address", async () => {
      const { user, backend } = await setup(c, ["default"]);
      const field = screen.getByRole("textbox", { name: "API URL" });
      await user.clear(field);
      await user.type(field, c.typedUrl);
      await user.tab();
      await waitFor(() => {
        expect(saved(backend)).toBe(c.savedUrl);
      });
      await user.clear(field);
      await user.type(field, "https://other.example.com{Escape}");
      expect(field).toHaveValue(c.savedUrl);
    });

    it("shows what the backend refuses under the field", async () => {
      const { user, backend } = await setup(c, ["default"]);
      const field = screen.getByRole("textbox", { name: "API URL" });
      await user.clear(field);
      await user.type(field, "http://gateway.example.com{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(/Use https:\/\//);
      expect(field).toBeInvalid();
      expect(saved(backend)).toBeNull();
      // Typing again clears the message.
      await user.type(field, "x");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("API Key", () => {
    it("saves a key, shows only its ending and refuses an empty one", async () => {
      const { user, backend } = await setup(c, ["default"]);
      const field = screen.getByLabelText(c.keyLabel);
      expect(field).toHaveAttribute("type", "password");
      expect(screen.getByText(/^No key saved\./)).toBeInTheDocument();
      const save = screen.getByRole("button", { name: "Save" });
      expect(save).toBeDisabled();
      await user.type(field, "sk-test-key-with-0abc");
      await user.click(save);
      expect(await screen.findByText("Saved, ends in 0abc")).toBeInTheDocument();
      expect(harnessSim(backend.world).keys[c.option]).toBe("sk-test-key-with-0abc");
      expect(field).toHaveValue("");
      expect(screen.queryByText(/sk-test-key/)).not.toBeInTheDocument();
    });

    it.runIf(c.typed)("says the key is optional and can be left empty", async () => {
      await setup(c, ["default"]);
      expect(screen.getByLabelText("API Key (optional)")).toBeInTheDocument();
      expect(screen.getByText(/Leave it empty if your server needs no key/)).toBeInTheDocument();
    });

    it.runIf(!c.typed)("does not call the key optional", async () => {
      await setup(c, ["default"]);
      expect(screen.queryByText(/optional/)).not.toBeInTheDocument();
    });

    it("refuses a key with spaces under the field", async () => {
      const { user } = await setup(c, ["default"]);
      await user.type(screen.getByLabelText(c.keyLabel), "two words");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/no spaces or line breaks/);
    });

    it("shows the saved hint and removes the key after a confirmation", async () => {
      const { user, backend } = await setupReady(c);
      expect(screen.getByText(`Saved, ends in ${c.key.slice(-4)}`)).toBeInTheDocument();
      expect(screen.getByLabelText(c.keyLabel)).toHaveAttribute(
        "placeholder",
        "Paste a new key to replace it",
      );
      await user.click(screen.getByRole("button", { name: "Remove…" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Remove the API key?" });
      expect(dialog).toHaveTextContent(/deleted from the server/);
      await user.click(within(dialog).getByRole("button", { name: "Remove Key" }));
      await waitFor(() => {
        expect(harnessSim(backend.world).keys[c.option]).toBeNull();
      });
      expect(await screen.findByText(/^No key saved\./)).toBeInTheDocument();
    });
  });

  describe.runIf(!c.typed)("Model list", () => {
    it("lists, searches and chooses a model, and counts them", async () => {
      const { user, backend } = await setupReady(c);
      const trigger = screen.getByRole("button", { name: "Model" });
      expect(trigger).toHaveTextContent(c.model);
      await user.click(trigger);
      const list = await screen.findByRole("dialog", { name: "Models" });
      expect(within(list).getAllByRole("option").length).toBeGreaterThan(5);
      expect(within(list).getByText(/\d+ models, updated/)).toBeInTheDocument();
      const search = within(list).getByRole("combobox", { name: "Search the models" });
      await user.type(search, "no such model anywhere");
      expect(within(list).getByText(/No model matches/)).toBeInTheDocument();
      await user.clear(search);
      await user.click(within(list).getByRole("option", { name: c.pick.name }));
      await waitFor(() => {
        expect(backend.world.harness.options[c.option].model).toBe(c.pick.id);
      });
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(c.pick.shown);
    });

    it("refreshes the list from the service", async () => {
      const { user, backend } = await setupReady(c);
      await user.click(screen.getByRole("button", { name: "Model" }));
      const list = await screen.findByRole("dialog", { name: "Models" });
      // The service goes down: only a request that really reaches it can fail now.
      harnessSim(backend.world).modelsFail = true;
      await user.click(within(list).getByRole("button", { name: "Refresh" }));
      expect(await within(list).findByText(/Refresh failed/)).toBeInTheDocument();
    });

    it("sizes the list itself instead of from the popper's late width variable", async () => {
      // `--radix-popover-trigger-width` is set after the first placement; a width taken from it
      // changes the list inside the callback of the ResizeObserver that watches it, which
      // WebKit reports as "ResizeObserver loop completed with undelivered notifications".
      const { user } = await setupReady(c);
      await user.click(screen.getByRole("button", { name: "Model" }));
      const list = await screen.findByRole("dialog", { name: "Models" });
      expect(list.className).not.toContain("--radix-popover-trigger-width");
      expect(list.style.width).toBe("300px");
    });

    it("asks for the list when it opens without one, and says when that fails", async () => {
      const { user } = await setup(c, ["default", "setup-models-fail"]);
      await user.click(screen.getByRole("button", { name: "Model" }));
      const list = await screen.findByRole("dialog", { name: "Models" });
      expect(await within(list).findByRole("alert")).toHaveTextContent(/Could not reach/);
      expect(within(list).getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    });

    it("asks for the list when the form opens", async () => {
      const { backend } = await setup(c, ["default"]);
      await waitFor(() => {
        expect(backend.world.apiModels[c.option]?.fetchedAt).toEqual(expect.any(Number));
      });
    });
  });

  describe.runIf(c.typed)("Model text box", () => {
    const modelOf = (backend: MockBackend) => backend.world.harness.options[c.option].model;

    it("is a monospace box with an example id and says what to type", async () => {
      await setup(c, ["default"]);
      const box = screen.getByRole("textbox", { name: "Model" });
      expect(box).toHaveValue("");
      expect(box).toHaveAttribute("placeholder", c.placeholder);
      expect(box).toHaveClass("font-mono");
      expect(screen.getByText(/The model id as the service names it/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Model" })).not.toBeInTheDocument();
    });

    it("shows the saved model", async () => {
      await setupReady(c);
      expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue(c.model);
    });

    it("saves the typed id, trimmed, on Return", async () => {
      const { user, backend } = await setup(c, ["default"]);
      const box = screen.getByRole("textbox", { name: "Model" });
      await user.type(box, "  my-local-model  {Enter}");
      await waitFor(() => {
        expect(modelOf(backend)).toBe("my-local-model");
      });
      expect(box).toHaveValue("my-local-model");
    });

    it("saves when the box loses focus", async () => {
      const { user, backend } = await setup(c, ["default"]);
      await user.type(screen.getByRole("textbox", { name: "Model" }), "qwen3-coder:30b");
      await user.tab();
      await waitFor(() => {
        expect(modelOf(backend)).toBe("qwen3-coder:30b");
      });
    });

    it("puts back the saved id on Esc, without saving what was typed", async () => {
      const { user, backend } = await setupReady(c);
      const box = screen.getByRole("textbox", { name: "Model" });
      await user.clear(box);
      await user.type(box, "something-else{Escape}");
      expect(box).toHaveValue(c.model);
      await user.tab();
      expect(modelOf(backend)).toBe(c.model);
    });

    it("clears the model when the box is emptied", async () => {
      const { user, backend } = await setupReady(c);
      const box = screen.getByRole("textbox", { name: "Model" });
      await user.clear(box);
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(modelOf(backend)).toBeNull();
      });
      expect(box).toHaveValue("");
    });

    it("shows what the backend refuses under the box, until typing goes on", async () => {
      const { user, backend } = await setup(c, ["default"]);
      const box = screen.getByRole("textbox", { name: "Model" });
      await user.type(box, "two words{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("That is not a model id.");
      expect(box).toBeInvalid();
      expect(modelOf(backend)).toBeNull();
      await user.type(box, "x");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("never asks the service for a list on its own", async () => {
      const { user, store } = await setup(c, ["default"]);
      // Opening, saving a key, saving the address and typing a model: none asks for models.
      await user.type(screen.getByLabelText(c.keyLabel), "sk-test-key-with-0abc");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Saved, ends in 0abc");
      const url = screen.getByRole("textbox", { name: "API URL" });
      await user.clear(url);
      await user.type(url, `${c.typedUrl}{Enter}`);
      await waitFor(() => {
        expect(url).toHaveValue(c.savedUrl);
      });
      await user.type(screen.getByRole("textbox", { name: "Model" }), "my-local-model{Enter}");
      await screen.findByDisplayValue("my-local-model");
      expect(store.getState().apiModels[c.option].status).toBe("idle");
    });

    it("says to type the model when the key is saved without one", async () => {
      const { user } = await setup(c, ["default"]);
      await user.type(screen.getByLabelText(c.keyLabel), "sk-test-key-with-0abc");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Saved, ends in 0abc");
      expect(getToasts().at(-1)).toMatchObject({
        title: "API key saved",
        description: "Now type a model.",
      });
    });

    it("warns about no model that the service does not list", async () => {
      await setupReady(c);
      expect(screen.queryByText(/no longer offers/)).not.toBeInTheDocument();
    });

    describe("Fetch Models", () => {
      const fetchButton = () => screen.getByRole("button", { name: "Fetch Models" });

      it("is enabled without a key: the key is optional on this option", async () => {
        await setup(c, ["default"]);
        expect(fetchButton()).toBeEnabled();
        expect(fetchButton()).not.toHaveAccessibleDescription();
      });

      it("is enabled once a key is saved", async () => {
        await setupReady(c);
        expect(fetchButton()).toBeEnabled();
        expect(fetchButton()).not.toHaveAccessibleDescription();
      });

      it("asks the service once, lists the models, and choosing one fills and saves the box", async () => {
        const { user, backend, store } = await setupReady(c);
        expect(store.getState().apiModels[c.option].status).toBe("idle");
        await user.click(fetchButton());
        const list = await screen.findByRole("dialog", { name: "Models" });
        expect(store.getState().apiModels[c.option].status).toBe("ready");
        expect(within(list).getAllByRole("option").length).toBeGreaterThan(5);
        expect(within(list).getByText(/\d+ models, updated/)).toBeInTheDocument();
        // The saved model is marked in the list.
        expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName(
          new RegExp(`\\(${c.model.replace(".", "\\.")}\\)$`),
        );
        const search = within(list).getByRole("combobox", { name: "Search the models" });
        await user.type(search, "no such model anywhere");
        expect(within(list).getByText(/No model matches/)).toBeInTheDocument();
        await user.clear(search);
        await user.click(within(list).getByRole("option", { name: c.pick.name }));
        await waitFor(() => {
          expect(backend.world.harness.options[c.option].model).toBe(c.pick.id);
        });
        expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue(c.pick.id);
        expect(screen.queryByRole("dialog", { name: "Models" })).not.toBeInTheDocument();
      });

      it("saves what was typed before it asks", async () => {
        const { user, backend } = await setupReady(c);
        const box = screen.getByRole("textbox", { name: "Model" });
        await user.clear(box);
        await user.type(box, "typed-first");
        await user.click(fetchButton());
        await screen.findByRole("dialog", { name: "Models" });
        expect(backend.world.harness.options[c.option].model).toBe("typed-first");
      });

      it("keeps a typed model that the list does not have", async () => {
        const { user, backend } = await setupReady(c);
        const box = screen.getByRole("textbox", { name: "Model" });
        await user.clear(box);
        await user.type(box, "not-in-any-list");
        await user.click(fetchButton());
        const list = await screen.findByRole("dialog", { name: "Models" });
        await user.keyboard("{Escape}");
        await waitFor(() => {
          expect(list).not.toBeInTheDocument();
        });
        expect(box).toHaveValue("not-in-any-list");
        expect(backend.world.harness.options[c.option].model).toBe("not-in-any-list");
        expect(screen.queryByText(/no longer offers/)).not.toBeInTheDocument();
      });

      it("says under the box when the service cannot be reached, and typing still works", async () => {
        const { user, backend } = await setupReady(c, {}, (b) => {
          const state = b.world.harness.options[c.option];
          state.baseUrl = "http://localhost:11434/v1";
          state.effectiveBaseUrl = "http://localhost:11434/v1";
        });
        await user.click(fetchButton());
        expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not reach the service/);
        expect(screen.queryByRole("dialog", { name: "Models" })).not.toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Model" })).toBeInvalid();
        const box = screen.getByRole("textbox", { name: "Model" });
        await user.clear(box);
        await user.type(box, "llama3.3:70b{Enter}");
        await waitFor(() => {
          expect(backend.world.harness.options[c.option].model).toBe("llama3.3:70b");
        });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });

      it("says when every model request fails", async () => {
        const { user } = await setupReady(c, {}, undefined, ["setup-models-fail"]);
        await user.click(fetchButton());
        expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach/);
        // Another press tries again.
        await user.click(fetchButton());
        expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach/);
      });
    });
  });

  describe("Reasoning effort and Test", () => {
    it.runIf(!c.typed)("remembers an effort for each model", async () => {
      const { user, backend } = await setupReady(c, { effort: true });
      const select = screen.getByRole("combobox", { name: "Reasoning effort" });
      expect(select).toHaveTextContent("Default");
      await user.click(select);
      await user.click(await screen.findByRole("option", { name: "High" }));
      await waitFor(() => {
        expect(backend.world.harness.options[c.option].efforts[c.model]).toBe("high");
      });
      expect(select).toHaveTextContent("High");

      // Another model has its own; choosing back shows the first one's again.
      await user.click(screen.getByRole("button", { name: "Model" }));
      await user.click(
        await within(await screen.findByRole("dialog", { name: "Models" })).findByRole("option", {
          name: c.pick.name,
        }),
      );
      await waitFor(() => {
        expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveTextContent(
          "Default",
        );
      });
      await user.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
      await user.click(await screen.findByRole("option", { name: "Default" }));
      expect(backend.world.harness.options[c.option].efforts[c.pick.id]).toBeUndefined();
      expect(backend.world.harness.options[c.option].efforts[c.model]).toBe("high");
    });

    it.runIf(c.typed)("remembers an effort for each typed model", async () => {
      const { user, backend } = await setupReady(c, { effort: true });
      const select = screen.getByRole("combobox", { name: "Reasoning effort" });
      expect(select).toHaveTextContent("Default");
      await user.click(select);
      await user.click(await screen.findByRole("option", { name: "High" }));
      await waitFor(() => {
        expect(backend.world.harness.options[c.option].efforts[c.model]).toBe("high");
      });
      expect(select).toHaveTextContent("High");

      // Another typed model has its own; typing the first one back shows its effort again.
      const box = screen.getByRole("textbox", { name: "Model" });
      await user.clear(box);
      await user.type(box, "my-local-model{Enter}");
      await waitFor(() => {
        expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveTextContent(
          "Default",
        );
      });
      await user.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
      await user.click(await screen.findByRole("option", { name: "Low" }));
      await waitFor(() => {
        expect(backend.world.harness.options[c.option].efforts["my-local-model"]).toBe("low");
      });
      await user.clear(box);
      await user.type(box, `${c.model}{Enter}`);
      await waitFor(() => {
        expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveTextContent(
          "High",
        );
      });
    });

    it.runIf(c.typed)("cannot choose an effort without a model", async () => {
      await setup(c, ["default"], { effort: true });
      expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeDisabled();
    });

    it("is not shown unless asked for", async () => {
      await setupReady(c);
      expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Test" })).not.toBeInTheDocument();
    });

    it("tests the connection and says what the service answered", async () => {
      const { user } = await setupReady(c, { test: true });
      expect(
        screen.getByText(new RegExp(`Sends one tiny request to ${c.service}`)),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Test" }));
      const result = await screen.findByRole("status");
      expect(result).toHaveTextContent(`${c.service} answered with`);
    });

    it("says why a test failed", async () => {
      const { user } = await setupReady(c, { test: true });
      await user.type(screen.getByLabelText(c.keyLabel), "bad-key-0000{Enter}");
      await screen.findByText("Saved, ends in 0000");
      await user.click(screen.getByRole("button", { name: "Test" }));
      const result = await screen.findByRole("alert");
      expect(result).toHaveTextContent(`${c.service} did not answer as expected`);
      expect(result).toHaveTextContent(/did not accept the API key/);
    });

    it("cannot test without a model, or on OpenCode Go without a key", async () => {
      await setup(c, ["default"], { test: true });
      expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    });

    it.runIf(c.typed)("tests without a key once a model is typed", async () => {
      const { user, backend } = await setup(c, ["default"], { test: true });
      await user.type(screen.getByRole("textbox", { name: "Model" }), "my-local-model{Enter}");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
      });
      await user.click(screen.getByRole("button", { name: "Test" }));
      expect(await screen.findByRole("status")).toHaveTextContent(`${c.service} answered with`);
      expect(harnessSim(backend.world).keys[c.option]).toBeNull();
    });
  });
});

describe("The saved model of OpenCode Go", () => {
  it("is flagged when the service no longer offers it", async () => {
    const go = CASES[0];
    if (!go) throw new Error("no case");
    await setup(go, ["setup-model-gone"]);
    expect(await screen.findByText(/no longer offers/)).toBeInTheDocument();
  });
});
