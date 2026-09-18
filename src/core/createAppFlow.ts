/**
 * The build, as named phases that match the wizard pages.
 *
 * GitHub holds the source, Cloudflare hosts every push, Cursor iterates. Those are
 * separate pages with their own buttons, so the work is split the same way:
 *
 *  1. **GitHub** — check the name, copy the starter, commit the identity files.
 *  2. **Cloudflare** — make sure its GitHub App can read the repo, create the Worker,
 *     wire push-to-deploy, start the first build, wait until the origin is serving,
 *     then offer the live URL to Haven.
 *  3. **Cursor** — hand the repository to a cloud agent. Optional, and never fatal.
 *
 * The identity commit happens on the GitHub page, before Cloudflare is involved, so
 * the first build is started explicitly rather than by hoping a later push wakes CI.
 *
 * Everything reaches the outside world through {@link CreateAppDependencies}, so the
 * whole sequence — including every failure path — is testable without a network.
 */
import type { AppIdentity, TemplateSources } from "./appIdentity";
import { buildIdentityFiles } from "./appIdentity";
import type { RepoReadableResult } from "./cloudflare";
import {
  externalMessage,
  externalNote,
  FlowNoteError,
  type FlowNote,
  type FlowNoteCode,
  type RepoAccessNextCode,
} from "./flowNotes";
import type { GitHubRepository } from "./github";
import type { OriginProbeResult } from "./originProbe";

export {
  FLOW_NOTE_CODES,
  FlowNoteError,
  isFlowNoteCode,
  type FlowNote,
  type FlowNoteCode,
  type RepoAccessNextCode,
} from "./flowNotes";

export type FlowStepId =
  | "check-name"
  | "create-repo"
  | "commit-identity"
  | "check-repo-access"
  | "create-worker"
  | "connect-builds"
  | "start-build"
  | "wait-origin"
  | "propose"
  | "launch-agent";

export type FlowStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface FlowStep {
  id: FlowStepId;
  status: FlowStepStatus;
  /**
   * One line for the user: what happened, or why it did not — as a code plus its values,
   * so the wording is chosen where it is rendered. Null while there is nothing to say.
   */
  detail: FlowNote | null;
}

export const GITHUB_PHASE_STEP_IDS: FlowStepId[] = [
  "check-name",
  "create-repo",
  "commit-identity",
];

export const CLOUDFLARE_PHASE_STEP_IDS: FlowStepId[] = [
  "check-repo-access",
  "create-worker",
  "connect-builds",
  "start-build",
  "wait-origin",
  "propose",
];

export const CURSOR_PHASE_STEP_IDS: FlowStepId[] = ["launch-agent"];

export const FLOW_STEP_IDS: FlowStepId[] = [
  ...GITHUB_PHASE_STEP_IDS,
  ...CLOUDFLARE_PHASE_STEP_IDS,
  ...CURSOR_PHASE_STEP_IDS,
];

/**
 * The rescue run: everything `deployNow` does after access was granted. A short list of
 * its own rather than the full one, because replaying "create the repository" as a
 * skipped step would suggest it might happen again.
 */
export const DEPLOY_NOW_STEP_IDS: FlowStepId[] = [
  "check-repo-access",
  "start-build",
  "wait-origin",
  "propose",
];

export const REGISTER_HAVEN_STEP_IDS: FlowStepId[] = ["propose"];

function createSteps(ids: FlowStepId[]): FlowStep[] {
  return ids.map((id) => ({ id, status: "pending", detail: null }));
}

export function createInitialSteps(): FlowStep[] {
  return createSteps(FLOW_STEP_IDS);
}

export function createGitHubPhaseSteps(): FlowStep[] {
  return createSteps(GITHUB_PHASE_STEP_IDS);
}

export function createCloudflarePhaseSteps(): FlowStep[] {
  return createSteps(CLOUDFLARE_PHASE_STEP_IDS);
}

export function createCursorPhaseSteps(): FlowStep[] {
  return createSteps(CURSOR_PHASE_STEP_IDS);
}

export function createDeployNowSteps(): FlowStep[] {
  return createSteps(DEPLOY_NOW_STEP_IDS);
}

export function createRegisterHavenSteps(): FlowStep[] {
  return createSteps(REGISTER_HAVEN_STEP_IDS);
}

export interface WorkerDeployment {
  /** Public URL, e.g. `https://team-notes.acme.workers.dev`. */
  url: string;
  /** Cloudflare's immutable script id. The Builds API keys off this, never the name. */
  scriptTag: string;
  /** True when the Worker already existed and was left alone. */
  reused: boolean;
}

export interface AgentHandle {
  id: string;
  url: string;
  runId: string;
}

export interface CreateAppDependencies {
  github: {
    getRepository: (owner: string, name: string) => Promise<GitHubRepository | null>;
    generateFromTemplate: (input: {
      name: string;
      description: string;
      private: boolean;
    }) => Promise<GitHubRepository>;
    readTemplateSources: (repository: GitHubRepository) => Promise<TemplateSources>;
    commitFiles: (input: {
      repository: GitHubRepository;
      message: string;
      files: Array<{ path: string; content: string }>;
    }) => Promise<string>;
  };
  cloudflare: {
    ensureWorker: (input: { name: string }) => Promise<WorkerDeployment>;
    /**
     * Whether Cloudflare can read the repository that was just created. Optional: with
     * no Cloudflare account to ask, the step is skipped rather than assumed.
     */
    checkRepoReadable?: (repository: GitHubRepository) => Promise<RepoReadableResult>;
    connectPushToDeploy: (input: {
      repository: GitHubRepository;
      worker: WorkerDeployment;
    }) => Promise<{ detail: FlowNote }>;
    /**
     * Start a build with no push behind it. Optional on the one-shot so older callers
     * still compile; the Cloudflare page always supplies it.
     */
    startBuild?: (input: {
      worker: WorkerDeployment;
      branch: string;
    }) => Promise<{ detail: FlowNote }>;
  };
  waitForOrigin: (input: { url: string; expectedAppId: string }) => Promise<OriginProbeResult>;
  cursor?: {
    launchAgent: (input: { repository: GitHubRepository }) => Promise<AgentHandle>;
  };
  haven?: {
    proposeApp: (
      url: string,
    ) => Promise<
      | { ok: true; appId: string; appInstanceId: string; label: string; warnings: string[] }
      | { ok: false; reason: "declined" | "unavailable"; message?: string }
    >;
  };
  /** Called after every step transition so the UI can follow along. */
  onStep?: (steps: FlowStep[]) => void;
  /**
   * Called once per finished phase with everything known so far, so the caller can
   * write it down before the next phase can fail.
   *
   * This is what makes a run resumable. A Cursor token that expires mid-build must not
   * cost the user the repository and the live URL the earlier phases produced — after
   * this fires, those are on disk and the app shows up in the list with a "carry on"
   * action. Awaited, so a phase boundary is a real checkpoint rather than a race with
   * the next API call.
   */
  onPhase?: (result: CreateAppResult) => void | Promise<void>;
}

/**
 * `deployNow` needs one thing `createApp` never used to: a way to start a build with no
 * push behind it. Required rather than optional, so the button cannot be offered by a
 * caller that has no way to honour it.
 */
export type DeployNowDependencies = CreateAppDependencies & {
  cloudflare: CreateAppDependencies["cloudflare"] & {
    startBuild: (input: {
      worker: WorkerDeployment;
      branch: string;
    }) => Promise<{ detail: FlowNote }>;
  };
};

export interface CreateAppInput {
  identity: AppIdentity;
  /** GitHub owner to create under. Blank means the token's own user. */
  owner: string;
  private?: boolean;
  /**
   * A repository this run already owns, from an earlier attempt that got this far and no
   * further.
   *
   * Without it a second attempt is impossible: the name check would find the project
   * from the first attempt and refuse, and the user would be left with a repository
   * carrying the template's name and no way to finish it.
   */
  existingRepository?: GitHubRepository;
}

export interface CreateAppResult {
  steps: FlowStep[];
  repository: GitHubRepository | null;
  worker: WorkerDeployment | null;
  agent: AgentHandle | null;
  installedAppInstanceId: string | null;
  /**
   * Whether the app's own name, brief and id made it into the repository.
   *
   * Tracked separately from `repository` because the two can come apart — GitHub copies
   * the template asynchronously, so a repository can exist while this commit has not
   * happened. An app in that state must be resumed *here*, not at publishing, or it goes
   * live under the template's identity.
   */
  identityCommitted: boolean;
  /** Non-fatal problems worth showing: a skipped agent, a declined install, warnings. */
  warnings: FlowNote[];
  /** Set when the flow stopped early. The step list says where. */
  error: FlowNote | null;
}

/**
 * What went wrong, as a note.
 *
 * A dependency that knew what happened says so with a {@link FlowNoteError}, and that note
 * is used as-is. A plain `Error` carries wording we did not write — GitHub's, Cloudflare's,
 * Cursor's — so it travels as an `external` note and is quoted rather than translated.
 * Anything else gets the caller's own code, which is the case a translator can act on.
 */
function readErrorMessage(error: unknown, fallback: FlowNoteCode): FlowNote {
  if (error instanceof FlowNoteError) {
    return error.note;
  }
  return error instanceof Error ? externalNote(error.message) : { code: fallback };
}

/**
 * Hand the caller what is known so far, at a phase boundary.
 *
 * Swallows its own failures. Writing the app down is bookkeeping the user benefits from;
 * a database that refuses the write is no reason to abandon a repository that exists and
 * a build that is running.
 */
async function checkpoint(deps: CreateAppDependencies, result: CreateAppResult): Promise<void> {
  if (!deps.onPhase) {
    return;
  }
  try {
    await deps.onPhase(result);
  } catch (error) {
    console.error("[app-builder] The app record could not be written:", error);
  }
}

/**
 * Step bookkeeping, shared by the runs so they report the same way.
 *
 * `abort` is the only way a run ends early, and it always leaves the same shape behind:
 * the failing step keeps the reason, later steps say skipped rather than pending, and
 * `error` carries the message the UI shows. `keepPending` leaves later work (Cursor)
 * runnable after a Cloudflare abort.
 */
interface StepRunner {
  result: CreateAppResult;
  update: (id: FlowStepId, status: FlowStepStatus, detail?: FlowNote | null) => void;
  abort: (id: FlowStepId, note: FlowNote, keepPending?: FlowStepId[]) => CreateAppResult;
  warn: (note: FlowNote) => void;
}

function createRunner(steps: FlowStep[], onStep?: (steps: FlowStep[]) => void): StepRunner {
  const result: CreateAppResult = {
    steps,
    repository: null,
    worker: null,
    agent: null,
    installedAppInstanceId: null,
    identityCommitted: false,
    warnings: [],
    error: null,
  };

  const emit = (): void => onStep?.(steps.map((entry) => ({ ...entry })));

  const update = (
    id: FlowStepId,
    status: FlowStepStatus,
    detail: FlowNote | null = null,
  ): void => {
    const step = steps.find((entry) => entry.id === id);
    if (step) {
      step.status = status;
      step.detail = detail;
    }
    emit();
  };

  const abort = (
    id: FlowStepId,
    note: FlowNote,
    keepPending: FlowStepId[] = [],
  ): CreateAppResult => {
    update(id, "failed", note);
    for (const step of steps) {
      if (step.status === "pending" && !keepPending.includes(step.id)) {
        step.status = "skipped";
      }
    }
    emit();
    result.error = note;
    return result;
  };

  return { result, update, abort, warn: (note) => result.warnings.push(note) };
}

/**
 * What to do about a repository Cloudflare cannot read, worded the same wherever it is
 * found — during the build, or again when the rescue build is asked for.
 *
 * One note rather than assembled fragments: the help text is four sentences that only
 * make sense together, and a translator handed half of them cannot reorder anything. The
 * two things that differ between the call sites travel as parameters — which button to
 * press next (itself a code, not a sentence) and Cloudflare's own refusal, quoted.
 */
function repoAccessFix(fullName: string, said: string, next: RepoAccessNextCode): FlowNote {
  return { code: "repoAccessFix", params: { fullName, said, next } };
}

/**
 * Poll the origin until the app is really being served. Returns false when the run is
 * over — `abort` has already recorded why.
 */
async function awaitOrigin(
  run: StepRunner,
  deps: CreateAppDependencies,
  worker: WorkerDeployment,
  expectedAppId: string,
  keepPending: FlowStepId[] = [],
): Promise<boolean> {
  try {
    run.update("wait-origin", "running", { code: "waitingForBuild" });
    const probe = await deps.waitForOrigin({ url: worker.url, expectedAppId });
    if (probe.state !== "ready") {
      // A silent origin means the build did not publish, and the reason for that lives
      // in Cloudflare's build log — not in anything this builder can see. Saying so
      // beats repeating that the origin is quiet, which the user already knows.
      //
      // One cause is still worth naming, because it leaves no trace in the build log
      // and `check-repo-access` only catches it when Cloudflare refuses clearly: if
      // Cloudflare's GitHub App is limited to hand-picked repositories, this one is not
      // among them, so no build was ever triggered and the Builds tab is empty.
      //
      // Carried as a warning rather than glued onto the front of the probe's own reason:
      // two notes stay two translatable sentences, and the step keeps saying exactly how
      // the origin was failing.
      if (probe.state !== "mismatched") {
        run.warn({ code: "originBuildLogHint" });
      }
      run.abort("wait-origin", probe.detail ?? { code: "originNotLiveInTime" }, keepPending);
      return false;
    }
    run.update("wait-origin", "done", { code: "originServing", params: { url: worker.url } });
    return true;
  } catch (error) {
    run.abort("wait-origin", readErrorMessage(error, "originCheckFailed"), keepPending);
    return false;
  }
}

/** Ask Haven to install the finished app. Never fatal: the app is live either way. */
async function proposeToHaven(
  run: StepRunner,
  deps: CreateAppDependencies,
  worker: WorkerDeployment,
): Promise<void> {
  if (!deps.haven) {
    run.update("propose", "skipped", { code: "havenNotGranted" });
    run.warn({ code: "havenAddManually", params: { url: worker.url } });
    return;
  }

  try {
    run.update("propose", "running");
    const proposed = await deps.haven.proposeApp(worker.url);
    if (proposed.ok) {
      run.result.installedAppInstanceId = proposed.appInstanceId;
      for (const warning of proposed.warnings) {
        // Haven used to report this when it asked the server for a brand-new
        // database id. The mapping is already on the registration; the first
        // write creates the store. It is not something this builder can fix.
        if (/could not create the database .+: not found/i.test(warning)) {
          continue;
        }
        // Haven's own wording, passed through: it knows what went wrong with the install
        // and this builder cannot improve on it.
        run.warn(externalNote(warning));
      }
      run.update("propose", "done", {
        code: "havenInstalled",
        params: { label: proposed.label },
      });
    } else if (proposed.reason === "declined") {
      run.update("propose", "skipped", { code: "havenDeclined" });
      run.warn({ code: "havenAddLater", params: { url: worker.url } });
    } else {
      const note: FlowNote = proposed.message
        ? externalNote(proposed.message)
        : { code: "havenReadFailed" };
      run.warn(note);
      run.update("propose", "failed", note);
    }
  } catch (error) {
    const note = readErrorMessage(error, "havenProposeFailed");
    run.warn(note);
    run.update("propose", "failed", note);
  }
}

async function runGitHubPhase(
  run: StepRunner,
  input: CreateAppInput,
  deps: CreateAppDependencies,
): Promise<boolean> {
  const { identity, owner } = input;
  const { result, update, abort } = run;

  /*
   * Resuming an app whose project exists: the name is taken by that project, which is
   * the good case, so neither checking nor creating applies. Both steps are marked
   * skipped rather than done — the user is looking at a list of what this run did.
   */
  if (input.existingRepository) {
    result.repository = input.existingRepository;
    update("check-name", "skipped", {
      code: "nameAlreadyYours",
      params: { fullName: input.existingRepository.fullName },
    });
    update("create-repo", "skipped", { code: "repoFromEarlierAttempt" });
  } else {
    update("check-name", "running");
    try {
      const existing = await deps.github.getRepository(owner, identity.slug);
      if (existing) {
        abort("check-name", { code: "nameTaken", params: { fullName: existing.fullName } });
        return false;
      }
      /*
       * The owner/repo path, like the two answers it sits beside — a bare slug is not
       * unique across owners, and the check is about the path. Composed rather than read,
       * because the repository does not exist yet; an owner left blank means "the token's
       * own user", which only GitHub can resolve, so the slug alone is the honest answer.
       */
      update("check-name", "done", {
        code: "nameAvailable",
        params: { fullName: owner ? `${owner}/${identity.slug}` : identity.slug },
      });
    } catch (error) {
      abort("check-name", readErrorMessage(error, "nameCheckFailed"));
      return false;
    }

    try {
      update("create-repo", "running");
      const repository = await deps.github.generateFromTemplate({
        name: identity.slug,
        description: identity.description,
        private: input.private ?? false,
      });
      result.repository = repository;
      update("create-repo", "done", {
        code: "repoCreated",
        params: { fullName: repository.fullName },
      });
    } catch (error) {
      abort("create-repo", readErrorMessage(error, "repoCreateFailed"));
      return false;
    }
  }

  try {
    update("commit-identity", "running");
    const repository = result.repository!;
    const sources = await deps.github.readTemplateSources(repository);
    const files = buildIdentityFiles(sources, identity);
    await deps.github.commitFiles({
      repository,
      message: `chore: set up ${identity.label}`,
      files,
    });
    result.identityCommitted = true;
    update("commit-identity", "done", {
      code: "identityCommitted",
      params: { count: files.length, label: identity.label },
    });
  } catch (error) {
    abort("commit-identity", readErrorMessage(error, "identityCommitFailed"));
    return false;
  }

  return true;
}

/**
 * Ask Cloudflare whether it can clone the repository. Returns `"unreadable"` when the
 * answer is a clear no — the caller decides whether that is fatal.
 */
async function checkCloudflareRepoAccess(
  run: StepRunner,
  deps: CreateAppDependencies,
  repository: GitHubRepository,
): Promise<"readable" | "unreadable" | "unknown"> {
  if (!deps.cloudflare.checkRepoReadable) {
    run.update("check-repo-access", "skipped", { code: "noCloudflareAccount" });
    return "unknown";
  }

  run.update("check-repo-access", "running");
  try {
    const readable = await deps.cloudflare.checkRepoReadable(repository);
    if (readable.state === "unreadable") {
      run.update("check-repo-access", "failed", readable.detail);
      return "unreadable";
    }
    // The check's own note already says whether the answer was a yes or an unconfirmed
    // maybe — `repoAccessUnconfirmed` carries that, so nothing is prefixed here.
    run.update("check-repo-access", "done", readable.detail);
    return readable.state === "readable" ? "readable" : "unknown";
  } catch (error) {
    // A check that could not run says nothing about the build, so it must not colour
    // one. This is the same reasoning as `unknown` inside the check itself.
    run.update("check-repo-access", "done", readErrorMessage(error, "repoAccessCheckFailed"));
    return "unknown";
  }
}

async function runCloudflarePhase(
  run: StepRunner,
  input: { identity: AppIdentity; repository: GitHubRepository; skipPropose?: boolean },
  deps: CreateAppDependencies,
  keepPending: FlowStepId[] = [],
): Promise<boolean> {
  const { result, update, abort, warn } = run;
  const { identity, repository } = input;

  const access = await checkCloudflareRepoAccess(run, deps, repository);
  let unreadable: FlowNote | null = null;
  if (access === "unreadable") {
    unreadable = repoAccessFix(
      repository.fullName,
      externalMessage(run.result.steps.find((step) => step.id === "check-repo-access")?.detail),
      "repoAccessNextStartFirstBuild",
    );
    warn(unreadable);
  }

  let worker: WorkerDeployment;
  try {
    update("create-worker", "running");
    worker = await deps.cloudflare.ensureWorker({ name: identity.slug });
    result.worker = worker;
    update("create-worker", "done", {
      code: worker.reused ? "workerReused" : "workerReserved",
      params: { url: worker.url },
    });
  } catch (error) {
    abort("create-worker", readErrorMessage(error, "workerCreateFailed"), keepPending);
    return false;
  }

  try {
    update("connect-builds", "running");
    const connected = await deps.cloudflare.connectPushToDeploy({ repository, worker });
    update("connect-builds", "done", connected.detail);
  } catch (error) {
    abort("connect-builds", readErrorMessage(error, "pushToDeployFailed"), keepPending);
    return false;
  }

  if (unreadable) {
    update("start-build", "skipped", { code: "noBuildWithoutAccess" });
    update("wait-origin", "skipped", { code: "noBuildWithoutAccess" });
    update("propose", "skipped", { code: "havenNeedsLiveUrl" });
    result.error = unreadable;
    return true;
  }

  if (!deps.cloudflare.startBuild) {
    update("start-build", "skipped", { code: "noStartBuildCapability" });
  } else {
    try {
      update("start-build", "running");
      const started = await deps.cloudflare.startBuild({
        worker,
        branch: repository.defaultBranch,
      });
      update("start-build", "done", started.detail);
    } catch (error) {
      abort("start-build", readErrorMessage(error, "buildStartFailed"), keepPending);
      return false;
    }
  }

  if (!(await awaitOrigin(run, deps, worker, identity.slug, keepPending))) {
    return false;
  }

  if (input.skipPropose) {
    run.update("propose", "skipped", { code: "pressRegisterInHaven" });
    return true;
  }

  await proposeToHaven(run, deps, worker);
  return true;
}

async function runCursorPhase(
  run: StepRunner,
  repository: GitHubRepository,
  deps: CreateAppDependencies,
): Promise<void> {
  if (!deps.cursor) {
    run.update("launch-agent", "skipped", { code: "noCursorKey" });
    return;
  }

  try {
    run.update("launch-agent", "running");
    const agent = await deps.cursor.launchAgent({ repository });
    run.result.agent = agent;
    run.update("launch-agent", "done", { code: "agentStarted", params: { url: agent.url } });
  } catch (error) {
    const note = readErrorMessage(error, "agentStartFailed");
    run.warn(note);
    run.update("launch-agent", "failed", note);
  }
}

/** Create the GitHub repository and write its identity. The Cloudflare page starts later. */
export async function createGitHubProject(
  input: CreateAppInput,
  deps: CreateAppDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createGitHubPhaseSteps(), deps.onStep);
  await runGitHubPhase(run, input, deps);
  await checkpoint(deps, run.result);
  return run.result;
}

export interface DeployCloudflareInput {
  identity: AppIdentity;
  repository: GitHubRepository;
  worker?: WorkerDeployment | null;
  /** The wizard registers Haven on its own button. */
  skipPropose?: boolean;
}

/** Wire Cloudflare, start the first build, wait for the URL, register in Haven. */
export async function deployToCloudflare(
  input: DeployCloudflareInput,
  deps: CreateAppDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createCloudflarePhaseSteps(), deps.onStep);
  run.result.repository = input.repository;
  run.result.worker = input.worker ?? null;
  await runCloudflarePhase(run, input, deps);
  await checkpoint(deps, run.result);
  return run.result;
}

export async function launchCursorWork(
  input: { repository: GitHubRepository; agent?: AgentHandle | null },
  deps: CreateAppDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createCursorPhaseSteps(), deps.onStep);
  run.result.repository = input.repository;
  run.result.agent = input.agent ?? null;
  await runCursorPhase(run, input.repository, deps);
  await checkpoint(deps, run.result);
  return run.result;
}

/** Offer a live Worker URL to Haven. Separate from the build so it can be pressed again. */
export async function registerInHaven(
  input: { worker: WorkerDeployment; repository?: GitHubRepository | null },
  deps: CreateAppDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createRegisterHavenSteps(), deps.onStep);
  run.result.worker = input.worker;
  run.result.repository = input.repository ?? null;
  await proposeToHaven(run, deps, input.worker);
  await checkpoint(deps, run.result);
  return run.result;
}

/**
 * Run every phase, in page order. Used by tests and as a one-shot; the wizard calls the
 * phases separately so each page owns its own buttons.
 *
 * Never throws: a build that fails halfway is a normal outcome the UI has to render,
 * and the step list plus `error` says exactly how far it got. Anything already created
 * is reported so the user can continue or clean up by hand rather than being told
 * "something went wrong".
 */
export async function createApp(
  input: CreateAppInput,
  deps: CreateAppDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createInitialSteps(), deps.onStep);

  const created = await runGitHubPhase(run, input, deps);
  // Checkpointed even on failure: a run that died after `create-repo` but before the
  // identity commit leaves a real repository behind, and the user has to be able to see
  // it — either to carry on or to delete it.
  await checkpoint(deps, run.result);
  if (!created) {
    return run.result;
  }

  const repository = run.result.repository!;
  await runCloudflarePhase(run, { identity: input.identity, repository }, deps, [
    "launch-agent",
  ]);
  await checkpoint(deps, run.result);

  if (repository) {
    await runCursorPhase(run, repository, deps);
    await checkpoint(deps, run.result);
  }

  return run.result;
}

export interface DeployNowInput {
  repository: GitHubRepository;
  worker: WorkerDeployment;
  /** The app id `haven-app.json` must advertise, so the origin probe knows what to look for. */
  appId: string;
  /** The agent the first run started, carried over so the result still links it. */
  agent?: AgentHandle | null;
}

/**
 * Build and finish an app whose first build never ran.
 *
 * The situation this exists for: the repository was created before Cloudflare's GitHub
 * App could read it, so the first build was never started. Once access is granted there
 * is no push left to make — the identity is already in the repository — and the app
 * would sit one dashboard visit away from working. This starts the build instead and
 * then picks the original sequence back up: wait for the origin, hand it to Haven.
 *
 * Access is re-checked first, and here a refusal *is* fatal. Nothing has been created,
 * so stopping costs nothing, and starting a build that Cloudflare cannot clone would
 * only replace a clear answer with a failed build log.
 */
export async function deployNow(
  input: DeployNowInput,
  deps: DeployNowDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createDeployNowSteps(), deps.onStep);
  const { result, update } = run;
  const { repository, worker } = input;

  result.repository = repository;
  result.worker = worker;
  result.agent = input.agent ?? null;

  const access = await checkCloudflareRepoAccess(run, deps, repository);
  if (access === "unreadable") {
    // The step's note is Cloudflare's refusal, and the abort replaces it — so the
    // refusal is carried into the help text rather than lost.
    const said = externalMessage(
      result.steps.find((step) => step.id === "check-repo-access")?.detail,
    );
    return run.abort(
      "check-repo-access",
      repoAccessFix(repository.fullName, said, "repoAccessNextBuildAgain"),
    );
  }

  try {
    update("start-build", "running");
    const started = await deps.cloudflare.startBuild({
      worker,
      branch: repository.defaultBranch,
    });
    update("start-build", "done", started.detail);
  } catch (error) {
    return run.abort("start-build", readErrorMessage(error, "buildStartFailed"));
  }

  if (!(await awaitOrigin(run, deps, worker, input.appId))) {
    await checkpoint(deps, result);
    return result;
  }

  await proposeToHaven(run, deps, worker);
  await checkpoint(deps, result);

  return result;
}
