/**
 * The storage area: the in-page folder picker's three functions (`fsPlaces`, `fsList`,
 * `fsCreateFolder`) with the rules and sentences of `server/src/storage/browse.js` and `paths.js`.
 * The mock disk is `world.fs` (see `seed/storage.ts`): folders only, `/` paths.
 */
import type { Api } from "../../api";
import type { FsEntry, FsListing, FsPlace } from "../../types";
import type { MockCtx } from "../ctx";
import type { MockUser, World } from "../world";
import { MEDIA_ROOT, personalFolder } from "./workspace";

export const PERSONAL_NAME = "My folder";
export const MEDIA_NAME = "Server storage";
export const TAKEN_MESSAGE = "This folder already belongs to a channel.";
export const OUTSIDE_MESSAGE = "This folder is outside the storage folders the admin allows.";
const NO_ACCESS_MESSAGE = "You do not have access to this folder.";
/** Names the picker makes are at most this long (`guard.safeName(name, { maxChars: 120 })`). */
const MAX_NAME_CHARS = 120;
const MAX_NAME_BYTES = 200;

// ---- paths -----------------------------------------------------------------------------------

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Natural order of `server/src/storage/names.js`: numbers by value, letters without case. */
function naturalCompare(a: string, b: string): number {
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

// ---- the disk --------------------------------------------------------------------------------

interface Root {
  name: string;
  path: string;
  available: boolean;
}

/** The storage folders in the order the picker shows them: the default one, then the admin's. */
function rootsOf(world: World): Root[] {
  const roots: Root[] = [{ name: MEDIA_NAME, path: MEDIA_ROOT, available: true }];
  for (const configured of world.adminSettings.storageRoots) {
    if (roots.some((root) => root.path === configured)) continue;
    roots.push({
      name: basename(configured) || configured,
      path: configured,
      available: world.fs.some((folder) => folder.path === configured),
    });
  }
  return roots;
}

/** Every folder that exists with its video count: the records, the channels and what is above. */
function knownFolders(world: World): Map<string, number> {
  const known = new Map<string, number>();
  const add = (path: string, videoCount: number | null) => {
    for (let at = path; ; at = dirname(at)) {
      if (!known.has(at)) known.set(at, 0);
      if (at === path && videoCount !== null) known.set(at, videoCount);
      if (at === "/") return;
    }
  };
  for (const folder of world.fs) add(folder.path, folder.videoCount);
  for (const channel of world.channels) add(channel.dir, null);
  return known;
}

function ensurePersonal(world: World, user: MockUser): string {
  const path = personalFolder(user.id);
  if (!world.fs.some((folder) => folder.path === path)) {
    world.fs.push({ path, name: user.id, videoCount: 0, children: [] });
  }
  return path;
}

export function storageArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;

  /** A path a user gave, made safe: inside a reachable storage folder, not another's folder. */
  function resolveFor(input: string, user: MockUser): string {
    if (input.includes("\0")) {
      throw ctx.errors.invalidInput("A folder path cannot contain a NUL character.");
    }
    if (!input.startsWith("/")) {
      throw ctx.errors.invalidInput(
        "Give the full path of the folder, starting at the top of the disk.",
      );
    }
    const names = input.split("/").filter((name) => name !== "" && name !== ".");
    if (names.includes("..")) throw ctx.errors.forbidden(OUTSIDE_MESSAGE);
    const real = `/${names.join("/")}`;
    if (!rootsOf(world).some((root) => root.available && isInside(root.path, real))) {
      throw ctx.errors.forbidden(OUTSIDE_MESSAGE);
    }
    if (real !== MEDIA_ROOT && isInside(MEDIA_ROOT, real)) {
      const first = real.slice(MEDIA_ROOT.length + 1).split("/")[0];
      if (world.users.some((other) => other.id === first && other.id !== user.id)) {
        throw ctx.errors.forbidden(NO_ACCESS_MESSAGE);
      }
    }
    return real;
  }

  return {
    fsPlaces: () =>
      ctx.run((): FsPlace[] => {
        const user = ctx.requireUser();
        return [
          {
            name: PERSONAL_NAME,
            path: ensurePersonal(world, user),
            kind: "personal",
            available: true,
          },
          ...rootsOf(world).map((root): FsPlace => ({
            name: root.name,
            path: root.path,
            kind: "storage",
            available: root.available,
          })),
        ];
      }),

    fsList: (input) =>
      ctx.run((): FsListing => {
        const user = ctx.requireUser();
        const asked = input?.path ?? ensurePersonal(world, user);
        const real = resolveFor(asked, user);
        const dirs = world.channels.map((channel) => channel.dir);
        const own = world.channels.filter((c) => c.userId === user.id).map((c) => c.dir);
        // Inside a channel of this user is theirs to look at; a stranger's is not.
        if (dirs.some((dir) => isInside(dir, real)) && !own.some((dir) => isInside(dir, real))) {
          throw ctx.errors.conflict(TAKEN_MESSAGE);
        }
        const known = knownFolders(world);
        if (!known.has(real)) throw ctx.errors.invalidInput("This folder does not exist.");

        const entries: FsEntry[] = [];
        for (const path of known.keys()) {
          if (path === real || dirname(path) !== real) continue;
          const name = basename(path);
          if (name.startsWith(".")) continue;
          if (real === MEDIA_ROOT && name !== user.id && world.users.some((u) => u.id === name)) {
            continue;
          }
          entries.push({
            name,
            path,
            taken: dirs.some((dir) => isInside(dir, path) || isInside(path, dir)),
          });
        }
        entries.sort((a, b) => naturalCompare(a.name, b.name));
        const root = rootsOf(world).find((r) => r.available && isInside(r.path, real));
        return {
          path: real,
          parent: root === undefined || root.path === real ? null : dirname(real),
          videoCount: known.get(real) ?? 0,
          entries,
        };
      }),

    fsCreateFolder: ({ parent, name }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const real = resolveFor(parent, user);
        const problem = nameProblem(name);
        if (problem !== null) throw ctx.errors.invalidInput(problem);
        if (world.channels.some((channel) => isInside(channel.dir, real))) {
          throw ctx.errors.conflict(TAKEN_MESSAGE);
        }
        const known = knownFolders(world);
        if (!known.has(real)) {
          throw ctx.errors.invalidInput("The folder to put it in does not exist.");
        }
        const path = `${real === "/" ? "" : real}/${name}`;
        if (known.has(path)) {
          throw ctx.errors.conflict("A folder with this name already exists here.");
        }
        world.fs.push({ path, name, videoCount: 0, children: [] });
        return { path };
      }),
  };
}
