/**
 * A small Markdown parser for Claude's messages in the activity log. Pure: it returns a tree of
 * plain data that `Markdown.tsx` turns into React elements, so no text is ever treated as HTML.
 *
 * Supported, as Claude writes it: paragraphs (single line breaks are kept), `#` headings, bullet
 * and numbered lists (nesting by indentation), block quotes, fenced code blocks, tables (shown as
 * they are, in monospace), horizontal rules, and inline `code`, **bold**, *italic*, ~~struck~~,
 * [links](url) and backslash escapes. Anything else stays literal text, so nothing is lost.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export interface ListItem {
  /** Nesting level, 0 for top-level items. */
  depth: number;
  /** "•" for bullets, "3." for numbered items (the number as written). */
  marker: string;
  children: Inline[];
}

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "quote"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "table"; text: string }
  | { type: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE = /^[ \t]*\|.*\|[ \t]*$/;

function indentWidth(indent: string): number {
  let width = 0;
  for (const c of indent) width += c === "\t" ? 4 : 1;
  return width;
}

/** Parses `text` into blocks. Never throws; unknown syntax becomes text. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence?.[1]) {
      flushParagraph();
      const marker = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const trimmed = next.trim();
        if (trimmed.startsWith(marker) && trimmed.replaceAll(marker[0] ?? "`", "") === "") break;
        body.push(next);
        i += 1;
      }
      i += 1; // the closing fence (or the end)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (TABLE.test(line)) {
      flushParagraph();
      const rows: string[] = [];
      while (i < lines.length && TABLE.test(lines[i] ?? "")) {
        rows.push((lines[i] ?? "").trim());
        i += 1;
      }
      blocks.push({ type: "table", text: rows.join("\n") });
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      let match: RegExpExecArray | null;
      while (i < lines.length && (match = QUOTE.exec(lines[i] ?? "")) !== null) {
        quoted.push(match[1] ?? "");
        i += 1;
      }
      blocks.push({ type: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flushParagraph();
      const ordered = !BULLET.test(line);
      const items: ListItem[] = [];
      /** Indentation widths of the open nesting levels. */
      const levels: number[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const bullet = BULLET.exec(current);
        const numbered = bullet ? null : NUMBERED.exec(current);
        if (bullet || numbered) {
          const width = indentWidth((bullet ?? numbered)?.[1] ?? "");
          while (levels.length > 0 && width < (levels.at(-1) ?? 0)) levels.pop();
          if (levels.length === 0 || width > (levels.at(-1) ?? 0)) levels.push(width);
          items.push({
            depth: levels.length - 1,
            marker: bullet ? "•" : `${numbered?.[2] ?? ""}${numbered?.[3] ?? "."}`,
            children: parseInline(bullet ? (bullet[2] ?? "") : (numbered?.[4] ?? "")),
          });
          i += 1;
          continue;
        }
        // An indented line continues the previous item ("lazy" continuation lines too).
        const last = items.at(-1);
        if (last && current.trim() !== "" && /^[ \t]+\S/.test(current)) {
          last.children.push({ type: "text", text: "\n" }, ...parseInline(current.trim()));
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}

/** `[text](target "title")`; the target may hold one level of parentheses. */
const LINK = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/;

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

function isSpace(c: string | undefined): boolean {
  return c === undefined || /\s/.test(c);
}

/** Index just past a code span starting at `i` (a run of backticks), or -1 when unclosed. */
function codeSpanEnd(src: string, i: number): { end: number; text: string } | null {
  let n = 0;
  while (src[i + n] === "`") n += 1;
  const fence = "`".repeat(n);
  let j = i + n;
  for (;;) {
    const k = src.indexOf(fence, j);
    if (k < 0) return null;
    // The closing run must be exactly as long.
    if (src[k + n] === "`" || src[k - 1] === "`") {
      j = k + 1;
      while (src[j] === "`") j += 1;
      continue;
    }
    let text = src.slice(i + n, k).replace(/\n/g, " ");
    if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ")) text = text.slice(1, -1);
    return { end: k + n, text };
  }
}

/**
 * Finds the closing `delim` for an opener that ends at `from`, skipping code spans, escapes and
 * (for a single `*` or `_`) doubled runs. Returns its index or -1.
 */
function findClosing(src: string, from: number, delim: string): number {
  let j = from;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      const span = codeSpanEnd(src, j);
      if (span) {
        j = span.end;
        continue;
      }
    }
    if (src.startsWith(delim, j)) {
      const single = delim.length === 1;
      const doubled = single && src[j + 1] === delim;
      if (doubled) {
        // Skip a nested strong run (`*a **b** c*`).
        j += 2;
        continue;
      }
      const before = src[j - 1];
      const after = src[j + delim.length];
      const intraword = delim[0] === "_" && isWordChar(after);
      if (!isSpace(before) && j > from && !intraword) return j;
    }
    j += 1;
  }
  return -1;
}

/** Parses inline Markdown. Unmatched markers stay literal. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ type: "text", text });
      text = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";

    if (c === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      text += src[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (c === "`") {
      const span = codeSpanEnd(src, i);
      if (span) {
        flush();
        out.push({ type: "code", text: span.text });
        i = span.end;
      } else {
        // An unclosed run stays literal as a whole.
        let n = 0;
        while (src[i + n] === "`") n += 1;
        text += src.slice(i, i + n);
        i += n;
      }
      continue;
    }

    if (c === "*" || c === "_" || c === "~") {
      const double = src[i + 1] === c;
      const delim = double ? c + c : c;
      const type = c === "~" ? (double ? "del" : null) : double ? "strong" : "em";
      const opensWord = !isSpace(src[i + delim.length]);
      // Underscores only emphasise whole words, so snake_case names stay as they are.
      const leftOk = c !== "_" || !isWordChar(src[i - 1]);
      if (type && opensWord && leftOk) {
        const close = findClosing(src, i + delim.length, delim);
        if (close > i + delim.length) {
          flush();
          out.push({ type, children: parseInline(src.slice(i + delim.length, close)) });
          i = close + delim.length;
          continue;
        }
      }
      // Not emphasis: keep the whole run literal so its parts are not reused.
      let n = 0;
      while (src[i + n] === c) n += 1;
      text += src.slice(i, i + n);
      i += n;
      continue;
    }

    if (c === "[") {
      const link = LINK.exec(src.slice(i));
      if (link?.[1] && link[2]) {
        flush();
        out.push({ type: "link", href: link[2], children: parseInline(link[1]) });
        i += link[0].length;
        continue;
      }
    }

    text += c;
    i += 1;
  }
  flush();
  return out;
}
