import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Button, Input, Select, type SelectOption } from "@/components/ui";
import { Callout, Row } from "@/features/settings";
import type { SettingsDraft } from "./useSettingsDraft";
import { parseWhole, rangeSentence, RANGES, type NumberKey, type RangedKey } from "./rules";

/**
 * The bar that appears under a page with unsaved changes. A refused save says why right here and
 * the changes stay, so nothing typed is lost.
 */
export function SaveBar({ draft, children }: { draft: SettingsDraft; children?: ReactNode }) {
  const { save } = draft;
  if (!draft.dirty && !save.error) return null;
  return (
    <div className="sticky bottom-3 z-10 flex flex-col gap-2">
      {save.error && (
        <Callout tone="danger" live title="The changes were not saved">
          {save.error.message}
        </Callout>
      )}
      {draft.dirty && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-border-container bg-elevated px-4 py-2.5 shadow-dialog"
        >
          <span className="min-w-0 flex-1 text-base text-fg">
            {children ?? "You have unsaved changes."}
          </span>
          <Button onClick={draft.revert} disabled={save.pending}>
            Revert
          </Button>
          <Button
            variant="primary"
            loading={save.pending}
            disabled={draft.hasInvalid}
            onClick={() => void save.run()}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

/** A whole number typed in a field of the draft; Up and Down step by one, Esc puts the saved value back. */
export function NumberRow({
  draft,
  field,
  label,
  description,
  unit,
}: {
  draft: SettingsDraft;
  field: RangedKey;
  label: string;
  description?: ReactNode;
  unit: string;
}) {
  const id = useId();
  const range = RANGES[field];
  const text = draft.text(field);
  const invalid = draft.invalid(field);
  const errorId = `${id}-error`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && draft.dirtyKeys.includes(field)) {
      // Handled here, so Esc does not also leave the screen.
      event.preventDefault();
      event.stopPropagation();
      draft.setText(field, String(draft.settings.data?.[field] ?? ""));
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const base = parseWhole(text, range) ?? draft.settings.data?.[field] ?? range.min;
      const step = event.key === "ArrowUp" ? 1 : -1;
      draft.setText(field, String(Math.min(range.max, Math.max(range.min, base + step))));
    }
  };

  return (
    <Row
      label={label}
      labelFor={id}
      description={description}
      control={
        <>
          <Input
            id={id}
            inputMode="numeric"
            value={text}
            invalid={invalid}
            aria-describedby={invalid ? `${id}-unit ${errorId}` : `${id}-unit`}
            className="w-[72px] text-right tabular"
            onChange={(event) => {
              draft.setText(field, event.target.value);
            }}
            onKeyDown={onKeyDown}
          />
          <span id={`${id}-unit`} className="w-16 text-base text-fg-muted">
            {unit}
          </span>
        </>
      }
    >
      {invalid && (
        <p id={errorId} role="alert" className="-mt-1 text-sm text-danger">
          {rangeSentence(range)}
        </p>
      )}
    </Row>
  );
}

/** A choice from a short list of numbers, kept in the draft as text. */
export function ChoiceRow({
  draft,
  field,
  label,
  description,
  options,
}: {
  draft: SettingsDraft;
  field: NumberKey;
  label: string;
  description?: ReactNode;
  options: readonly SelectOption[];
}) {
  const id = useId();
  return (
    <Row
      label={label}
      labelFor={id}
      description={description}
      control={
        <Select
          id={id}
          className="min-w-[96px]"
          value={draft.text(field)}
          options={options}
          onValueChange={(value) => {
            draft.setText(field, value);
          }}
        />
      }
    />
  );
}
