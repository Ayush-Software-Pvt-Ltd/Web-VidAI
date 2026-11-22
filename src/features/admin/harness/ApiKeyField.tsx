/**
 * "API Key" of one option: password field with Save, the saved hint, Remove (with a confirmation).
 * The key is optional on the Anthropic and OpenAI compatible options, which say so. The server keeps
 * it encrypted and answers only whether one is saved and its last 4 characters.
 */
import { CircleCheck } from "lucide-react";
import { useId, useState } from "react";
import { Button, ConfirmDialog, Input, toast } from "@/components/ui";
import { Row, useAction } from "@/features/settings";
import { useApi, useAppStoreApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { SETUP_INFO, keyRequired } from "@/lib/setup";
import type { ApiOption } from "@/lib/types";
import { keyEnding } from "./model";
import { useApiOption, useHarnessCommit } from "./useApiOption";

/** The two buttons beside the key field have the same size. */
const KEY_BUTTON = "min-w-[84px]";

export function ApiKeyField({ option, test = false }: { option: ApiOption; test?: boolean }) {
  const api = useApi();
  const store = useAppStoreApi();
  const commit = useHarnessCommit();
  const { keySaved, keyLast4, model } = useApiOption(option);
  const info = SETUP_INFO[option];
  const [key, setKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const id = useId();
  const saved = keySaved === true;
  const optional = !keyRequired(option);

  const save = useAction(async () => {
    await commit(api.adminSetApiKey({ option, key }));
    setKey("");
    // A key may see models the list of the address did not show without it (OpenCode Go's list;
    // the other options fetch only when Fetch Models is pressed).
    if (option === "opencodeGo") void store.getState().loadApiModels(option, true);
    const verb = option === "opencodeGo" ? "choose" : "type";
    // The next step is what the form offers: Test only exists where the form has it.
    toast.success(
      "API key saved",
      model === null
        ? test
          ? `${capitalize(verb)} a model, then Test the connection.`
          : `Now ${verb} a model.`
        : test
          ? "Test the connection to check it."
          : undefined,
    );
  });

  const remove = async () => {
    try {
      // Removing the key of the selected OpenCode Go puts edits back on the Claude subscription;
      // the other options keep running without a key (the server answers the new state).
      await commit(api.adminClearApiKey({ option }));
      toast.success("API key removed", `The key of ${info.service} is deleted.`);
    } catch (error) {
      toast.error("The key was not removed", toApiError(error).message);
    }
  };

  return (
    <>
      <Row
        className="p-0"
        label={optional ? "API Key (optional)" : "API Key"}
        labelFor={id}
        description={
          keySaved === null ? (
            <span className="block h-3.5 w-28 animate-pulse rounded-sm bg-muted" aria-hidden />
          ) : saved ? (
            <span className="flex items-center gap-1.5">
              <CircleCheck className="size-3.5 text-success" aria-hidden />
              Saved, {keyEnding(keyLast4)}
            </span>
          ) : optional ? (
            "No key saved. Leave it empty if your server needs no key."
          ) : (
            "No key saved."
          )
        }
      >
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() !== "") void save.run();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="password"
              value={key}
              autoComplete="off"
              placeholder={
                saved
                  ? "Paste a new key to replace it"
                  : optional
                    ? "Paste an API key if your server needs one"
                    : "Paste your API key"
              }
              wrapperClassName="flex-1"
              className={key === "" ? undefined : "font-mono"}
              invalid={save.error !== null}
              aria-describedby={`${id}-note`}
              onChange={(event) => {
                setKey(event.target.value);
                save.clearError();
              }}
            />
            <Button
              type="submit"
              variant={saved ? "secondary" : "primary"}
              className={KEY_BUTTON}
              loading={save.pending}
              disabled={key.trim() === "" || keySaved === null}
            >
              Save
            </Button>
            {saved && (
              <Button
                className={KEY_BUTTON}
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                Remove{"…"}
              </Button>
            )}
          </div>
          <p
            id={`${id}-note`}
            role={save.error ? "alert" : undefined}
            className={save.error ? "text-xs text-danger" : "text-xs text-fg-muted"}
          >
            {save.error
              ? save.error.message
              : "Kept encrypted on the server. VidAI never shows it again."}
          </p>
        </form>
      </Row>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the API key?"
        description={
          optional
            ? `It is deleted from the server. Edits on ${info.label} then run without a key, which works only if your server needs none; you can add a key again at any time.`
            : `It is deleted from the server. If edits run on ${info.label} they go back to Claude Code with Claude Subscription; you can add a key again at any time.`
        }
        confirmLabel="Remove Key"
        tone="danger"
        onConfirm={remove}
      />
    </>
  );
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
