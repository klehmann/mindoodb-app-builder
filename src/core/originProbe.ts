/**
 * "Is the app actually live?"
 *
 * Between creating a repository and telling Haven about it there is a gap the builder
 * cannot shortcut: Cloudflare has to finish a build and publish the assets. Proposing
 * the app to Haven before `haven-app.json` is readable would fail the install for a
 * reason that has nothing to do with the user.
 *
 * So the builder polls the origin the same way Haven will read it — a cross-origin
 * `fetch` of `haven-app.json` — and only advances when that succeeds and the definition
 * names the app we just created. Using Haven's own check as the readiness signal means
 * a pass here is evidence the install will work, not a guess.
 */
import {
  resolveMindooDBAppDefinitionUrl,
  validateMindooDBAppDefinition,
  type MindooDBAppDefinition,
} from "mindoodb-app-sdk";

export type OriginProbeState =
  /** Nothing answered yet — DNS, the first build, or the Worker route is still coming up. */
  | "unreachable"
  /** Something answered, but not a usable `haven-app.json` (often the placeholder Worker). */
  | "not-published"
  /** A valid definition is being served, but for a different app than expected. */
  | "mismatched"
  | "ready";

export interface OriginProbeResult {
  state: OriginProbeState;
  definition: MindooDBAppDefinition | null;
  /** Short, user-facing reason. Empty when `state` is `"ready"`. */
  detail: string;
}

export interface ProbeOriginOptions {
  /** App origin or a full `haven-app.json` URL; both work. */
  url: string;
  /** When set, a definition with a different `appId` reports `"mismatched"`. */
  expectedAppId?: string;
  /** Defaults to 10s. A cold Worker can take a few seconds to answer. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** One attempt. Never throws: an unreachable origin is an expected state here. */
export async function probeOrigin(options: ProbeOriginOptions): Promise<OriginProbeResult> {
  const { url, expectedAppId, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;

  const definitionUrl = resolveMindooDBAppDefinitionUrl(url);
  if (!definitionUrl) {
    return { state: "unreachable", definition: null, detail: "No app URL yet." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(definitionUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    return {
      state: "unreachable",
      definition: null,
      detail: "The origin did not answer yet.",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      state: "not-published",
      definition: null,
      detail: `haven-app.json answered HTTP ${response.status}.`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      state: "not-published",
      definition: null,
      detail: "haven-app.json is not JSON yet — the deploy is probably still running.",
    };
  }

  const { definition, errors } = validateMindooDBAppDefinition(payload);
  if (!definition) {
    return {
      state: "not-published",
      definition: null,
      detail: errors[0] ?? "haven-app.json is not a valid app definition.",
    };
  }

  if (expectedAppId && definition.appId !== expectedAppId) {
    return {
      state: "mismatched",
      definition,
      detail: `The origin serves "${definition.appId}" but this app is "${expectedAppId}".`,
    };
  }

  return { state: "ready", definition, detail: "" };
}

export interface WaitForOriginOptions extends ProbeOriginOptions {
  /** Defaults to 5 minutes, which covers a cold first Cloudflare build. */
  totalTimeoutMs?: number;
  /** Defaults to 3s. */
  intervalMs?: number;
  /** Called after every attempt so the UI can show progress instead of a spinner. */
  onAttempt?: (result: OriginProbeResult, attempt: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 3_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the origin serves the expected app, or the budget runs out. Returns the
 * last result either way — a caller that ran out of time still wants to tell the user
 * *how* it was failing.
 *
 * A `"mismatched"` origin stops the loop: waiting longer cannot fix pointing at the
 * wrong app, and silently installing it would be worse.
 */
export async function waitForOrigin(options: WaitForOriginOptions): Promise<OriginProbeResult> {
  const {
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    onAttempt,
    sleep = defaultSleep,
    now = () => Date.now(),
    ...probeOptions
  } = options;

  const deadline = now() + totalTimeoutMs;
  let attempt = 0;
  let last: OriginProbeResult = {
    state: "unreachable",
    definition: null,
    detail: "Not checked yet.",
  };

  for (;;) {
    attempt += 1;
    last = await probeOrigin(probeOptions);
    onAttempt?.(last, attempt);

    if (last.state === "ready" || last.state === "mismatched") {
      return last;
    }
    if (now() + intervalMs >= deadline) {
      return last;
    }
    await sleep(intervalMs);
  }
}
