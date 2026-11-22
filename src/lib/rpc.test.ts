import { describe, expect, it } from "vitest";
import { EVENT_NAMES, PUBLIC_RPC_NAMES, RPC_NAMES } from "./rpc";

import spec from "../../docs/SPEC.md?raw";

const serverFiles = import.meta.glob<string>("../../server/src/**/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The function names of SPEC section 14: the backticked names in its "RPC functions" bullets. */
function specNames(): string[] {
  const start = spec.indexOf("RPC functions (");
  const end = spec.indexOf("\nEvents:", start);
  const lines = spec
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("- "));
  // A name is the first word of a backticked item; text after it in the same item is a note.
  return lines.flatMap((line) =>
    [...line.matchAll(/`([a-z][A-Za-z0-9]*)(?:\(|`)/g)].map((m) => m[1] as string),
  );
}

function serverSource(): string {
  return Object.values(serverFiles).join("\n");
}

describe("rpc names", () => {
  it("are unique", () => {
    expect(new Set(RPC_NAMES).size).toBe(RPC_NAMES.length);
  });

  it("match the functions of SPEC section 14", () => {
    const names = specNames();
    expect(names.length).toBeGreaterThan(50);
    const spec = new Set(names);
    expect(RPC_NAMES.filter((name) => !spec.has(name))).toEqual([]);
    expect(names.filter((name) => !(RPC_NAMES as readonly string[]).includes(name))).toEqual([]);
  });

  it("exist in the server's code", () => {
    const source = serverSource();
    expect(RPC_NAMES.filter((name) => !new RegExp(`\\b${name}\\b`).test(source))).toEqual([]);
  });

  it("keep public functions a subset and events listed", () => {
    for (const name of PUBLIC_RPC_NAMES) expect(RPC_NAMES).toContain(name);
    expect(EVENT_NAMES).toHaveLength(12);
  });
});
