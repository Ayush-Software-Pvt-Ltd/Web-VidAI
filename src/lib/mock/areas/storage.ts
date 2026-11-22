/**
 * The storage area: the admin's folder picker (`fsPlaces`, `fsList`, `fsCreateFolder`) over the
 * mock server's whole file system (`fsModel.ts`, seeded by `seed/storage.ts`), and `listUploads`
 * lives in the uploads area. Every function answers `forbidden` to a user (SPEC section 6,
 * "Folders on the server"); a folder that does not exist or lies in an unavailable place answers
 * `notFound`.
 */
import type { Api } from "../../api";
import type { FsEntry, FsListing, FsPlace } from "../../types";
import type { MockCtx } from "../ctx";
import {
  basename,
  dirname,
  diskFolders,
  driveRootOf,
  isInside,
  placeOf,
  realPath,
} from "../fsModel";

export const TAKEN_MESSAGE = "This folder already belongs to a channel.";
export const DATA_MESSAGE = "This folder belongs to VidAI's own data.";
export const MISSING_MESSAGE = "This folder does not exist or cannot be read.";
/** Names the picker makes are at most this long (`guard.safeName(name, { maxChars: 120 })`). */
const MAX_NAME_CHARS = 120;
const MAX_NAME_BYTES = 200;

// ---- names -----------------------------------------------------------------------------------

/** Natural order of `server/src/storage/names.js`: numbers by value, letters without case. */
export function naturalCompare(a: string, b: string): number {
  const chunks = (text: string) => text.match(/\d+|\D+/g) ?? [];
  const left = chunks(a);
  const right = chunks(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index] ?? "";
    const y = right[index] ?? "";
    const xDigits = /^\d/.test(x);
    const yDigits = /^\d/.test(y);
    let order: number;
    if (xDigits && yDigits) {
      const tx = x.replace(/^0+/, "");
      const ty = y.replace(/^0+/, "");
      order = tx.length - ty.length || (tx < ty ? -1 : tx > ty ? 1 : 0);
    } else if (xDigits) order = -1;
    else if (yDigits) order = 1;
    else {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      order = lx < ly ? -1 : lx > ly ? 1 : 0;
    }
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Why `name` is no good name for a new folder (`nameProblem` of the server), or `null`. */
function nameProblem(name: string): string | null {
  if (name === "") return "A name cannot be empty.";
  if (name === "." || name === "..") return 'A name cannot be "." or "..".';
  if (name.includes("/") || name.includes("\\")) return "A name cannot contain a slash.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "A name cannot contain control characters.";
  if (name.startsWith(".")) return "A name cannot start with a dot.";
  if (name !== name.trim()) return "A name cannot start or end with a space.";
  if (/[‪-‮⁦-⁩]/.test(name)) {
    return "A name cannot contain characters that change the text direction.";
  }
  if (Array.from(name).length > MAX_NAME_CHARS) {
    return `A name can have at most ${String(MAX_NAME_CHARS)} characters.`;
  }
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return "That name is too long.";
  return null;
}

export function storageArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;

  /** A path the admin gave, made real: absolute, without `..`. */
  function resolve(input: string): string {
    if (input.includes("\0")) {
      throw ctx.errors.invalidInput("A folder path cannot contain a NUL character.");
    }
    if (!input.startsWith("/")) {
      throw ctx.errors.invalidInput(
        "Give the full path of the folder, starting at the top of the disk.",
      );
    }
    return realPath(input);
  }

  return {
    fsPlaces: () =>
      ctx.run((): FsPlace[] => {
        ctx.requireAdmin();
        return world.fsPlaces.map((place) => ({ ...place }));
      }),

    fsList: (input) =>
      ctx.run((): FsListing => {
        ctx.requireAdmin();
        const asked = input?.path ?? world.fsPlaces.find((p) => p.kind === "home")?.path ?? "/";
        const real = resolve(asked);
        const known = diskFolders(world);
        if (!known.has(real)) throw ctx.errors.notFound(MISSING_MESSAGE);
        const dirs = world.channels.map((channel) => channel.dir);
        const entries: FsEntry[] = [];
        for (const path of known.keys()) {
          if (path === real || dirname(path) !== real) continue;
          const name = basename(path);
          if (name.startsWith(".")) continue;
          entries.push({
            name,
            path,
            taken:
              dirs.some((dir) => isInside(dir, path) || isInside(path, dir)) ||
              isInside(world.dataDir, path),
          });
        }
        entries.sort((a, b) => naturalCompare(a.name, b.name));
        const top = driveRootOf(world, real);
        return {
          path: real,
          parent: top === null || top === real ? null : dirname(real),
          videoCount: known.get(real) ?? 0,
          entries,
        };
      }),

    fsCreateFolder: ({ parent, name }) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const real = resolve(parent);
        const problem = nameProblem(name);
        if (problem !== null) throw ctx.errors.invalidInput(problem);
        const known = diskFolders(world);
        if (!known.has(real)) throw ctx.errors.notFound("The folder to put it in does not exist.");
        const path = `${real === "/" ? "" : real}/${name}`;
        if (known.has(path)) {
          throw ctx.errors.conflict("A folder with this name already exists here.");
        }
        if (placeOf(world, path)?.available === false) throw ctx.errors.notFound(MISSING_MESSAGE);
        world.fs.push({ path, name, videoCount: 0 });
        return { path };
      }),
  };
}
