import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { fieldBase } from "./Input";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Monospace text, for prompt and style editors. */
  mono?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ mono, invalid, className, rows = 4, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      spellCheck={!mono}
      className={cn(
        fieldBase,
        "block resize-y px-2.5 py-1.5 leading-[18px]",
        mono ? "font-mono text-sm leading-[18px]" : "text-base",
        className,
      )}
      {...rest}
    />
  );
}
