/**
 * "Model" of the options that take a typed model (Anthropic and OpenAI compatible APIs; the
 * service can be anything, often a model server on this computer): a text box for the id as the
 * service names it, saved on Return or blur (Esc reverts, empty clears), and Fetch Models, which
 * asks the service for its list once, on press, and offers it to choose from. A typed id needs no
 * list: nothing here asks the service until Fetch Models is pressed. OpenCode Go has the
 * searchable `ModelCombobox` instead.
 */
import { ListChecks } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useRef, useState } from "react";
import { Button, Input, Tooltip } from "@/components/ui";
import { returnFocus } from "@/components/ui/focusReturn";
import { Row, useAction } from "@/features/settings";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import type { ApiModel, ApiOption } from "@/lib/types";
import { ModelListPopup } from "./ModelListPopup";
import { roomBelow } from "./modelListPlacement";
import { fetchProblem } from "./model";
import { useApiOption, useHarnessCommit } from "./useApiOption";

/** An example id per option, shown while the box is empty. */
const PLACEHOLDER: Record<ApiOption, string> = {
  opencodeGo: "",
  anthropicApi: "claude-sonnet-5-5",
  openaiApi: "gpt-5.3",
};

export function ApiModelField({
  option,
  disabled = false,
}: {
  option: ApiOption;
  disabled?: boolean;
}) {
  const api = useApi();
  const store = useAppStoreApi();
  const commitState = useHarnessCommit();
  const { model, keySaved, baseUrl } = useApiOption(option);
  const models = useAppState((s) => s.apiModels[option]);
  const shown = model ?? "";
  const [text, setText] = useState(shown);
  // A new saved model (the list's choice, another window) replaces what the box shows.
  const [lastShown, setLastShown] = useState(shown);
  if (shown !== lastShown) {
    setLastShown(shown);
    setText(shown);
  }
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(0);
  // The height the list may take below the row, `null` when it may open above instead.
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Another address offers other models and has other errors.
  const [lastUrl, setLastUrl] = useState(baseUrl);
  if (baseUrl !== lastUrl) {
    setLastUrl(baseUrl);
    setFetchError(null);
  }
  const rowRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const commit = useAction(async (value: string | null) => {
    store.getState().clearApiTest(option);
    const state = await commitState(api.adminSetApiModel({ option, model: value }));
    setText(state.options[option].model ?? "");
  });

  const submit = () => {
    if (text.trim() === shown) {
      setText(shown);
      commit.clearError();
      return;
    }
    void commit.run(text.trim() === "" ? null : text);
  };

  const problem = fetchProblem(option, keySaved);
  const fetching = models.status === "loading";

  const fetchModels = async () => {
    setFetchError(null);
    await store.getState().loadApiModels(option, true);
    const result = store.getState().apiModels[option];
    if (result.status === "error") {
      setFetchError(result.error?.message ?? "The models could not be loaded.");
    } else if (result.status === "ready") {
      if (result.data?.models.length) {
        if (rowRef.current) {
          // Scrolls the field up first, so the list opens below it and covers nothing above.
          setMaxHeight(roomBelow(rowRef.current));
          setWidth(rowRef.current.getBoundingClientRect().width);
        }
        setOpen(true);
      } else {
        setFetchError("The service lists no models. Type the model id instead.");
      }
    }
  };

  const choose = (picked: ApiModel) => {
    setOpen(false);
    if (picked.id !== model) {
      setText(picked.id);
      void commit.run(picked.id);
    }
  };

  const error = commit.error?.message ?? fetchError;

  return (
    <Row
      className="p-0"
      label="Model"
      labelFor={id}
      description="The model id as the service names it. Every edit on this option uses this model, also for its sub-agents and background tasks."
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          {/* The button sits beside the box, so the help text above keeps the full width. */}
          <div ref={rowRef} className="flex items-center gap-2">
            <Input
              id={id}
              value={text}
              placeholder={PLACEHOLDER[option]}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={disabled}
              wrapperClassName="min-w-0 flex-1"
              className="font-mono text-sm"
              invalid={error !== null}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setText(event.target.value);
                commit.clearError();
                setFetchError(null);
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
            <Tooltip content={problem} side="top">
              {/* A disabled button gets no pointer events, so the tooltip sits on its wrapper. */}
              <span className="inline-flex">
                <Button
                  ref={buttonRef}
                  icon={<ListChecks />}
                  loading={fetching}
                  disabled={disabled || problem !== null}
                  aria-description={problem ?? undefined}
                  onClick={() => void fetchModels()}
                >
                  Fetch Models
                </Button>
              </span>
            </Tooltip>
          </div>
        </Popover.Anchor>
        <ModelListPopup
          models={models}
          value={model}
          width={width}
          maxHeight={maxHeight}
          onChoose={choose}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (buttonRef.current) returnFocus(buttonRef.current);
          }}
        />
      </Popover.Root>
      {error && (
        <p id={`${id}-error`} role="alert" className="-mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </Row>
  );
}
