/** "API URL" of one option: pre-filled with the default, saved on Return or blur, Reset to Default. */
import { RotateCcw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button, Input } from "@/components/ui";
import { Row, useAction } from "@/features/settings";
import { useApi, useAppStoreApi } from "@/lib/appEnv";
import { API_DEFAULT_BASE_URL } from "@/lib/setup";
import type { ApiOption } from "@/lib/types";
import { useApiOption, useHarnessCommit } from "./useApiOption";

const URL_HELP: Record<ApiOption, ReactNode> = {
  opencodeGo: (
    <>
      The Go subscription address is filled in. For a pay-as-you-go balance, use{" "}
      <span className="font-mono">https://opencode.ai/inference/anthropic</span> instead.
    </>
  ),
  anthropicApi:
    "Anthropic's own API is filled in. Use another address for a gateway or a service that speaks the same protocol.",
  openaiApi:
    "The address of an OpenAI Compatible API, ending in /v1. OpenCode Go's OpenAI form is filled in.",
};

export function ApiUrlField({ option }: { option: ApiOption }) {
  const api = useApi();
  const store = useAppStoreApi();
  const fallback = API_DEFAULT_BASE_URL[option];
  const commitState = useHarnessCommit();
  const { baseUrl: saved } = useApiOption(option);
  const shown = saved ?? fallback;
  const [text, setText] = useState(shown);
  // A new saved address (Reset to Default, another window) replaces what the field shows.
  const [lastShown, setLastShown] = useState(shown);
  if (shown !== lastShown) {
    setLastShown(shown);
    setText(shown);
  }
  const id = useId();

  const commit = useAction(async (value: string | null) => {
    const state = await commitState(api.adminSetApiBaseUrl({ option, baseUrl: value }));
    const now = state.options[option].baseUrl;
    setText(now ?? fallback);
    // Another address offers other models (OpenCode Go's list; the other options fetch only
    // when Fetch Models is pressed).
    if (now !== saved && option === "opencodeGo") void store.getState().loadApiModels(option, true);
  });

  const submit = () => {
    if (text.trim() === shown) {
      setText(shown);
      commit.clearError();
      return;
    }
    void commit.run(text.trim() === "" ? null : text);
  };

  return (
    <Row className="p-0" label="API URL" labelFor={id} description={URL_HELP[option]}>
      {/* The button sits beside the field, so the help text above keeps the full width. */}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrapperClassName="min-w-0 flex-1"
          className="font-mono text-sm"
          invalid={commit.error !== null}
          aria-describedby={commit.error ? `${id}-error` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            commit.clearError();
          }}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && text !== shown) {
              event.preventDefault();
              event.stopPropagation();
              setText(shown);
              commit.clearError();
            }
          }}
        />
        {saved !== null && (
          <Button
            icon={<RotateCcw />}
            loading={commit.pending}
            onClick={() => void commit.run(null)}
          >
            Reset to Default
          </Button>
        )}
      </div>
      {commit.error && (
        <p id={`${id}-error`} role="alert" className="-mt-1 text-sm text-danger">
          {commit.error.message}
        </p>
      )}
    </Row>
  );
}
