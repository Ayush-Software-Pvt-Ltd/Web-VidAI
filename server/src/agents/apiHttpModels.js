// Reading the model lists of a service (docs/SPEC.md section 5, "Harness, program
// and model").
//
// The Anthropic form is `{"data":[{"type":"model","id","display_name","created_at"}],
// "has_more","last_id"}`, paged with `after_id`; the OpenAI form is `{"data":[{"id"}]}` (extra
// fields, as Ollama and LM Studio add them, are ignored).

/**
 * @typedef {import("../../../src/lib/wire/harness.ts").ApiModel} ApiModel
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} body @returns {unknown} */
function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * One page of the Anthropic form: its models, and the id to continue after when there is more.
 * A server that answers the Anthropic path with the OpenAI form (no `type`) is read too.
 * @param {string} body
 * @returns {{ models: ApiModel[], next: string | null } | null} null when it is not a list.
 */
export function parseModelsPage(body) {
  const value = parseJson(body);
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  /** @type {ApiModel[]} */
  const models = [];
  for (const entry of /** @type {unknown[]} */ (value.data)) {
    if (!isRecord(entry)) continue;
    if (entry.type !== undefined && entry.type !== null && entry.type !== "model") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "") continue;
    const name = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
    models.push({ id, displayName: name === "" ? id : name });
  }
  let next = null;
  if (value.has_more === true) {
    next = typeof value.last_id === "string" ? value.last_id : (models.at(-1)?.id ?? null);
  }
  return { models, next };
}

/**
 * The OpenAI form of `GET /models`. The name of a model is its id; repeated ids count once.
 * @param {string} body
 * @returns {ApiModel[] | null} null when it is not a list.
 */
export function parseOpenaiModels(body) {
  const value = parseJson(body);
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  /** @type {ApiModel[]} */
  const models = [];
  for (const entry of /** @type {unknown[]} */ (value.data)) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (id !== "" && !models.some((model) => model.id === id)) {
      models.push({ id, displayName: id });
    }
  }
  return models;
}
