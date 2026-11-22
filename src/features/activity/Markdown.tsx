/**
 * Renders the agent's Markdown (see `parseMarkdown.ts`) as React elements. Safe by construction:
 * text only ever becomes React text children, never HTML. Only `http` and `https` links are
 * links (they open in a new tab and pass no referrer); any other target (`javascript:`, `data:`,
 * `file:`) stays plain text with the target in the tooltip, so nothing in a message can run code.
 */
import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { parseMarkdown, type Block, type Inline } from "./parseMarkdown";

/** Whether a link target is a plain web address (anything else is never made a link). */
function isWebLink(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code
            key={i}
            className="rounded-sm bg-muted px-1 py-px font-mono text-[0.9em] [overflow-wrap:anywhere]"
          >
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold">
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={i}>{renderInline(node.children)}</del>;
      case "link":
        return isWebLink(node.href) ? (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noreferrer"
            title={node.href}
            className="text-accent-text underline-offset-2 hover:underline"
          >
            {renderInline(node.children)}
          </a>
        ) : (
          <span key={i} title={node.href} className="text-accent-text">
            {renderInline(node.children)}
          </span>
        );
    }
  });
}

const preClass =
  "rounded-md border border-separator bg-subtle px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap";

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(block.children)}
        </p>
      );
    case "heading":
      return (
        <p key={key} className="font-semibold whitespace-pre-wrap" data-heading={block.level}>
          {renderInline(block.children)}
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List key={key} className="flex flex-col gap-0.5">
          {block.items.map((item, i) => (
            <li
              key={i}
              className="flex gap-1.5"
              style={item.depth > 0 ? { paddingLeft: `${item.depth * 16}px` } : undefined}
            >
              <span
                className={cn(
                  "shrink-0 text-fg-muted tabular",
                  block.ordered ? "min-w-4 text-right" : "w-2.5 text-center",
                )}
              >
                {item.marker}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {renderInline(item.children)}
              </span>
            </li>
          ))}
        </List>
      );
    }
    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-border-strong pl-2 whitespace-pre-wrap text-fg-muted"
        >
          {renderInline(block.children)}
        </blockquote>
      );
    case "code":
    case "table":
      return (
        <pre key={key} className={preClass}>
          {block.text}
        </pre>
      );
    case "rule":
      return <hr key={key} className="my-0.5 border-separator" />;
  }
}

/** Claude's message as formatted text; parsed once per text. */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  );
});
