import { useRef, useState, type ElementType } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./Tooltip";

export interface TruncatedTextProps {
  text: string;
  className?: string;
  /** Element to render, default `span`. */
  as?: ElementType;
  side?: "top" | "bottom";
}

/**
 * Single-line text with an ellipsis. Shows the full text in a tooltip only when it is actually
 * cut off. Handles mixed scripts (Latin and Devanagari) through `dir="auto"`.
 */
export function TruncatedText({
  text,
  className,
  as: Tag = "span",
  side = "top",
}: TruncatedTextProps) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      content={text}
      side={side}
      align="start"
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && el !== null && el.scrollWidth > el.clientWidth + 1);
      }}
    >
      <Tag ref={ref} dir="auto" className={cn("block min-w-0 truncate", className)}>
        {text}
      </Tag>
    </Tooltip>
  );
}
