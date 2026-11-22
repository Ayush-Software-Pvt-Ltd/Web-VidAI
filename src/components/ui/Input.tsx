import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Leading icon inside the field, for example `<Search />`. */
  icon?: ReactNode;
  /** Trailing content inside the field, for example a clear button or a `<Kbd>`. */
  trailing?: ReactNode;
  size?: "sm" | "md";
  invalid?: boolean;
  /** Classes for the outer wrapper (width, margins). */
  wrapperClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export const fieldBase =
  "w-full rounded-md border border-border bg-surface text-fg shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.04)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--c-focus)] disabled:opacity-50 disabled:hover:border-border aria-invalid:border-danger aria-invalid:focus-visible:shadow-[0_0_0_3px_var(--c-danger-soft)]";

export function Input({
  icon,
  trailing,
  size = "md",
  invalid,
  className,
  wrapperClassName,
  ref,
  ...rest
}: InputProps) {
  return (
    <div className={cn("relative flex items-center", wrapperClassName)}>
      {icon && (
        <span className="pointer-events-none absolute left-2 flex text-fg-subtle [&_svg]:size-3.5">
          {icon}
        </span>
      )}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          fieldBase,
          size === "sm" ? "h-6 px-2 text-sm" : "h-7 px-2.5 text-base",
          icon !== undefined && (size === "sm" ? "pl-6" : "pl-7"),
          trailing !== undefined && "pr-8",
          className,
        )}
        {...rest}
      />
      {trailing && <span className="absolute right-1.5 flex items-center">{trailing}</span>}
    </div>
  );
}
