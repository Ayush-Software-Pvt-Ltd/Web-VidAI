/**
 * Settings, Appearance (SPEC section 16): the theme and the text size. Both apply at once and are
 * kept in this browser's local storage (`src/app/appearance.ts`), never on the server.
 */
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import type { ReactNode } from "react";
import {
  nextTextSize,
  saveAppearance,
  stepTextSize,
  useAppearanceSettings,
  type TextStep,
} from "@/app/appearance";
import { Button, SegmentedControl, Tooltip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TEXT_SIZE, type Theme } from "@/lib/types";
import { Group, Row, SettingsPage } from "./layout";

const THEME_OPTIONS = [
  { value: "system", label: "System", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
] as const satisfies readonly { value: Theme; label: string; icon: ReactNode }[];

export function AppearanceSection() {
  const { theme, textSize } = useAppearanceSettings();

  return (
    <SettingsPage>
      <Group
        title="Display"
        description="How VidAI looks for you."
        footer="Your choice is kept in this browser. Your other browsers and computers keep their own."
      >
        <Row
          label="Theme"
          description="System follows the light or dark appearance of your computer and changes with it."
          control={
            <SegmentedControl
              aria-label="Theme"
              value={theme}
              options={THEME_OPTIONS}
              onValueChange={(next) => {
                saveAppearance({ theme: next });
              }}
            />
          }
        />
        <Row
          label="Text size"
          description={`Makes all text and controls bigger or smaller. The default is ${String(TEXT_SIZE.default)} pt.`}
          control={<TextSizeControl textSize={textSize} onStep={stepTextSize} />}
        />
      </Group>
    </SettingsPage>
  );
}

function TextSizeControl({
  textSize,
  onStep,
}: {
  textSize: number;
  onStep: (step: TextStep) => void;
}) {
  const atDefault = textSize === TEXT_SIZE.default;
  return (
    <>
      {!atDefault && (
        <Button variant="ghost" icon={<RotateCcw />} onClick={() => onStep("default")}>
          Reset to Default
        </Button>
      )}
      <div
        role="group"
        aria-label="Text size"
        className="inline-flex shrink-0 items-center gap-px rounded-md bg-muted p-0.5"
      >
        <StepButton
          label="Make Text Smaller"
          disabled={nextTextSize(textSize, "smaller") === textSize}
          onClick={() => onStep("smaller")}
        >
          <span aria-hidden className="text-[11px] leading-none">
            A
          </span>
        </StepButton>
        <output
          aria-live="polite"
          aria-label={`Text size ${String(textSize)} points`}
          className="tabular min-w-[52px] px-1 text-center text-base font-medium text-fg"
        >
          {textSize} pt
        </output>
        <StepButton
          label="Make Text Bigger"
          disabled={nextTextSize(textSize, "bigger") === textSize}
          onClick={() => onStep("bigger")}
        >
          <span aria-hidden className="text-[16px] leading-none">
            A
          </span>
        </StepButton>
      </div>
    </>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "focus-ring inline-flex h-6 w-8 items-center justify-center rounded-[5px] font-semibold text-fg transition-[background-color,box-shadow] duration-100",
          "bg-control shadow-control enabled:hover:bg-control-hover enabled:active:bg-control-active disabled:text-fg-disabled disabled:shadow-none disabled:bg-transparent",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
