// What an error answer of a service means, as one readable sentence
// (docs/SPEC.md section 5, "Harness, program and model"). Used by Test, the model list, the quota and the job errors of every API option.
//
// An `opencode.ai` address keeps the OpenCode wording; any other address uses generic texts that
// call the service "the service". Where a sentence says what to do, the wording depends on who
// reads it: an admin is pointed at the settings screen, anybody else is told to ask the admin
// (`audience`).

/** @typedef {"opencode" | "generic"} Service */
/** @typedef {"admin" | "user"} Audience */

/**
 * The service of an address: OpenCode for `opencode.ai` and `*.opencode.ai`, otherwise generic.
 * @param {string} baseUrl
 * @returns {Service}
 */
export function serviceForBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai") ? "opencode" : "generic";
  } catch {
    return "generic";
  }
}

/**
 * For the start of a sentence.
 * @param {Service} service
 */
export function subjectOf(service) {
  return service === "opencode" ? "OpenCode" : "The service";
}

/**
 * For the middle of a sentence.
 * @param {Service} service
 */
export function objectOf(service) {
  return service === "opencode" ? "OpenCode" : "the service";
}

/**
 * What `failureText` says when neither a status nor the text tells anything.
 * @param {Service} service
 */
export function unknownFailure(service) {
  return service === "opencode" ? "OpenCode reported an error." : "The service reported an error.";
}

/**
 * The parts of an error answer: `{"type":"error","error":{"type","message"},"metadata":{...}}`.
 * The JSON may follow other text (Claude Code's "API Error: 429 {...}"); an OpenAI style error
 * (`{"error":{"message","type","code"}}`) is read the same way.
 * @param {string} text
 * @returns {{ kind: string | null, message: string | null, limitName: string | null }}
 */
export function parseError(text) {
  /** @type {unknown} */
  let value = null;
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      value = JSON.parse(text.slice(start).trim());
    } catch {
      value = null;
    }
  }
  /** @param {unknown} node @param {string[]} path @returns {string | null} */
  const field = (node, path) => {
    let current = node;
    for (const name of path) {
      if (typeof current !== "object" || current === null) return null;
      current = /** @type {Record<string, unknown>} */ (current)[name];
    }
    return typeof current === "string" ? current : null;
  };
  return {
    kind: field(value, ["error", "type"]),
    message: field(value, ["error", "message"]),
    limitName: field(value, ["metadata", "limitName"]),
  };
}

/**
 * The Go window a `limitName` names, as the texts say it.
 * @param {string | null} name
 * @returns {string | null}
 */
function windowLabel(name) {
  switch (name?.trim().toLowerCase()) {
    case "5 hour":
    case "5-hour":
    case "rolling":
      return "5-hour";
    case "weekly":
      return "weekly";
    case "monthly":
      return "monthly";
    default:
      return null;
  }
}

/**
 * The pointers to the admin's screen, by who reads the sentence.
 * @type {Record<Audience, { chooseModel: string, enterKey: string }>}
 */
const POINTERS = {
  admin: {
    chooseModel: "Choose another model in Settings, Harness + API Keys.",
    enterKey: "Enter one in Settings, Harness + API Keys.",
  },
  user: {
    chooseModel: "Ask the admin to choose another model.",
    enterKey: "Ask the admin to enter one.",
  },
};

/**
 * One readable sentence for an error answer of `service`.
 * @param {number | null} status The HTTP status when known.
 * @param {string} text The body, or a text that contains it.
 * @param {string | null} [model] Named when the model is the problem.
 * @param {{ service?: Service, hasKey?: boolean, audience?: Audience }} [options]
 *   `service` defaults to OpenCode. `hasKey: false` (the request carried no key; the key is
 *   optional on two options) makes a 401 ask for a key instead of blaming one never sent.
 *   `audience` defaults to the admin.
 * @returns {string}
 */
export function failureText(status, text, model = null, options = {}) {
  const { service = "opencode", hasKey = true, audience = "admin" } = options;
  const pointers = POINTERS[audience];
  if (!hasKey && status === 401) return `The service wants an API key. ${pointers.enterKey}`;
  const error = parseError(text);
  const kind = error.kind ?? "";
  const lower = `${error.message ?? ""} ${text}`.toLowerCase();
  const theModel = model === null ? "this model" : `the model ${model}`;
  const open = service === "opencode";
  const subject = subjectOf(service);
  if (kind === "GoUsageLimitError" || lower.includes("go usage limit")) {
    const window = windowLabel(error.limitName);
    return window === null
      ? "A limit of your OpenCode Go plan is reached. It resets on its own; the OpenCode console shows when."
      : `The ${window} limit of your OpenCode Go plan is reached. It resets on its own; the OpenCode console shows when.`;
  }
  if (
    kind === "BudgetLimitError" ||
    lower.includes("budget exceeded") ||
    lower.includes("budget policy")
  ) {
    return open
      ? "An OpenCode budget limit is reached. Raise it in the OpenCode console, or wait until it resets."
      : "A budget limit of the service is reached. Raise it with the service, or wait until it resets.";
  }
  if (kind === "FreeUsageLimitError") {
    return open
      ? "The free OpenCode limit is reached. Try again later, or choose a paid model."
      : "The free limit of the service is reached. Try again later, or choose a paid model.";
  }
  if (
    status === 402 ||
    kind === "CreditLimitExceeded" ||
    lower.includes("insufficient account funds") ||
    lower.includes("credit limit")
  ) {
    return open
      ? "Your OpenCode balance is used up. Add credit in the OpenCode console."
      : "Your balance with the service is used up. Add credit with the service.";
  }
  if (lower.includes("invoice is overdue")) {
    return open
      ? "Your OpenCode account has an overdue invoice. Settle it in the OpenCode console."
      : "Your account with the service has an overdue invoice. Settle it with the service.";
  }
  if (
    status === 401 ||
    kind === "authentication_error" ||
    kind === "AuthError" ||
    lower.includes("invalid credential")
  ) {
    return open
      ? "OpenCode did not accept the API key. Check that you copied the whole key, or make a new one in the OpenCode console."
      : "The service did not accept the API key. Check that you copied the whole key, or make a new one with the service.";
  }
  if (
    status === 404 ||
    kind === "not_found_error" ||
    kind === "ModelError" ||
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("not supported")
  ) {
    return `${subject} does not offer ${theModel} at this address. ${pointers.chooseModel}`;
  }
  if (status === 403 || kind === "permission_error") {
    return open
      ? `OpenCode does not allow ${theModel} for this key: it is not in your plan, or it is a free model that only works in OpenCode's own apps. ${pointers.chooseModel}`
      : `The service does not allow ${theModel} for this key: it is not in your plan. ${pointers.chooseModel}`;
  }
  if (status === 429 || kind === "rate_limit_error" || lower.includes("rate limit")) {
    return `${subject} is limiting requests right now. Try again in a minute.`;
  }
  if (status !== null && status >= 500 && status <= 599) {
    return `${subject} is having problems right now (error ${status}). Try again later.`;
  }
  if (status !== null) return `${subject} answered with an unexpected error (HTTP ${status}).`;
  return unknownFailure(service);
}
