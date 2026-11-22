import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Inline } from "./parseMarkdown";

const text = (t: string): Inline => ({ type: "text", text: t });

describe("parseInline", () => {
  it("parses bold, italic, struck, code and links", () => {
    expect(parseInline("a **b** *c* _d_ ~~e~~ `f` [g](https://x.y)")).toEqual([
      text("a "),
      { type: "strong", children: [text("b")] },
      text(" "),
      { type: "em", children: [text("c")] },
      text(" "),
      { type: "em", children: [text("d")] },
      text(" "),
      { type: "del", children: [text("e")] },
      text(" "),
      { type: "code", text: "f" },
      text(" "),
      { type: "link", href: "https://x.y", children: [text("g")] },
    ]);
  });

  it("nests emphasis and keeps code literal", () => {
    expect(parseInline("**bold _and italic_**")).toEqual([
      {
        type: "strong",
        children: [text("bold "), { type: "em", children: [text("and italic")] }],
      },
    ]);
    expect(parseInline("[a](https://x.y/f(1))")).toEqual([
      { type: "link", href: "https://x.y/f(1)", children: [text("a")] },
    ]);
    expect(parseInline("*a **b** c*")).toEqual([
      { type: "em", children: [text("a "), { type: "strong", children: [text("b")] }, text(" c")] },
    ]);
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", text: "**not bold**" }]);
    expect(parseInline("``a ` b``")).toEqual([{ type: "code", text: "a ` b" }]);
  });

  it("leaves text alone that only looks like Markdown", () => {
    for (const plain of [
      "snake_case_name and file_v2_final.mp4",
      "2 * 3 * 4",
      "Broll/**/*.mp4",
      "[OUTPUT COMPLETED]",
      "an unclosed **bold",
      "an unclosed `tick",
      "~single~ tilde",
      "price is $5 * qty",
    ]) {
      expect(parseInline(plain)).toEqual([text(plain)]);
    }
    expect(parseInline("\\*literal\\* \\`tick\\`")).toEqual([text("*literal* `tick`")]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs and keeps single line breaks", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", children: [text("one\ntwo")] },
      { type: "paragraph", children: [text("three")] },
    ]);
  });

  it("parses headings, rules, quotes, tables and fenced code", () => {
    const blocks = parseMarkdown(
      "# Title #\n---\n> quoted **x**\n| a | b |\n|---|---|\n```py\nprint('**hi**')\n\n```\n### Small",
    );
    expect(blocks).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      { type: "rule" },
      { type: "quote", children: [text("quoted "), { type: "strong", children: [text("x")] }] },
      { type: "table", text: "| a | b |\n|---|---|" },
      { type: "code", text: "print('**hi**')\n" },
      { type: "heading", level: 3, children: [text("Small")] },
    ]);
  });

  it("keeps an unclosed code fence to the end", () => {
    expect(parseMarkdown("```\nline 1\nline 2")).toEqual([
      { type: "code", text: "line 1\nline 2" },
    ]);
  });

  it("parses bullet and numbered lists with nesting and continuation lines", () => {
    expect(parseMarkdown("- a\n  - b\n    more\n- c\n\n3. x\n4) y")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { depth: 0, marker: "•", children: [text("a")] },
          { depth: 1, marker: "•", children: [text("b"), text("\n"), text("more")] },
          { depth: 0, marker: "•", children: [text("c")] },
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [
          { depth: 0, marker: "3.", children: [text("x")] },
          { depth: 0, marker: "4)", children: [text("y")] },
        ],
      },
    ]);
  });

  it("handles empty and whitespace-only text and Windows line ends", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\n ")).toEqual([]);
    expect(parseMarkdown("a\r\nb")).toEqual([{ type: "paragraph", children: [text("a\nb")] }]);
  });

  it("parses a long log quickly", () => {
    const message =
      "## Step\n\nI'll **cut** the `pauses` and *plan* the b-roll:\n\n1. one\n2. two\n\n```\ncode\n```";
    const start = performance.now();
    for (let i = 0; i < 5_000; i++) parseMarkdown(`${message} ${i}`);
    // Generous bound: the log renders a window of rows, so this is far more than one render.
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
