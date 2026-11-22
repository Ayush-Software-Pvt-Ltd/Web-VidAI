// Where the toolkit is, shipped and installed (docs/SPEC.md section 7).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPaths } from "../config.js";
import { venvPython } from "../platform/python.js";

/**
 * The toolkit folder of the repository, found from this file's own place
 * (`server/src/toolkit/paths.js` to `toolkit/`).
 * @returns {string}
 */
export function shippedToolkitDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "toolkit");
}

/**
 * Every path of the installed toolkit.
 * @param {string} dataDir
 * @param {NodeJS.Platform} [platform]
 */
export function toolkitPaths(dataDir, platform = process.platform) {
  const root = dataPaths(dataDir).toolkitDir;
  const venvDir = path.join(root, "venv");
  const toolkitFolder = path.join(root, "CLAUDE_VE_ALL");
  return {
    /** `<data dir>/toolkit`. */
    root,
    /** `<root>/CLAUDE_VE_ALL`, where `ve.py` is. */
    toolkitFolder,
    /** The folder the last upgrade replaced. */
    previousFolder: path.join(root, "CLAUDE_VE_ALL.previous"),
    claudeMd: path.join(root, "CLAUDE.md"),
    memoryFile: path.join(root, "MEMORY.md"),
    versionFile: path.join(root, "VERSION"),
    venvDir,
    /** The environment's Python (`venv/bin/python`, `venv\Scripts\python.exe`). */
    python: venvPython(venvDir, platform),
    requirements: path.join(toolkitFolder, "requirements.txt"),
    driver: path.join(toolkitFolder, "ve.py"),
    /** The recorded steps of Prepare. */
    prepareFile: path.join(root, "prepare.json"),
  };
}

/**
 * What the others get from `api.paths()` (the job manager puts `toolkitFolder` and `python` into
 * the prompt header).
 * @param {string} dataDir
 * @param {string | null} version The installed toolkit version.
 * @param {NodeJS.Platform} [platform]
 */
export function publicPaths(dataDir, version, platform = process.platform) {
  const p = toolkitPaths(dataDir, platform);
  return {
    root: p.root,
    toolkitFolder: p.toolkitFolder,
    python: p.python,
    memoryFile: p.memoryFile,
    version,
  };
}
