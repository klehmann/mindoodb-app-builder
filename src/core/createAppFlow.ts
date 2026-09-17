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
import type { GitHubRepository } from "./github";
import type { OriginProbeResult } from "./originProbe";

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
  /** One line for the user: what happened, or why it did not. */
  detail: string;
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
  return ids.map((id) => ({ id, status: "pending", detail: "" }));
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
    }) => Promise<{ detail: string }>;
    /**
     * Start a build with no push behind it. Optional on the one-shot so older callers
     * still compile; the Cloudflare page always supplies it.
     */
    startBuild?: (input: {
      worker: WorkerDeployment;
      branch: string;
    }) => Promise<{ detail: string }>;
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
    }) => Promise<{ detail: string }>;
  };
};

export interface CreateAppInput {
  identity: AppIdentity;
  /** GitHub owner to create under. Blank means the token's own user. */
  owner: string;
  private?: boolean;
}

export interface CreateAppResult {
  steps: FlowStep[];
  repository: GitHubRepository | null;
  worker: WorkerDeployment | null;
  agent: AgentHandle | null;
  installedAppInstanceId: string | null;
  /** Non-fatal problems worth showing: a skipped agent, a declined install, warnings. */
  warnings: string[];
  /** Set when the flow stopped early. The step list says where. */
  error: string | null;
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  update: (id: FlowStepId, status: FlowStepStatus, detail?: string) => void;
  abort: (id: FlowStepId, message: string, keepPending?: FlowStepId[]) => CreateAppResult;
  warn: (message: string) => void;
}

function createRunner(steps: FlowStep[], onStep?: (steps: FlowStep[]) => void): StepRunner {
  const result: CreateAppResult = {
    steps,
    repository: null,
    worker: null,
    agent: null,
    installedAppInstanceId: null,
    warnings: [],
    error: null,
  };

  const emit = (): void => onStep?.(steps.map((entry) => ({ ...entry })));

  const update = (id: FlowStepId, status: FlowStepStatus, detail = ""): void => {
    const step = steps.find((entry) => entry.id === id);
    if (step) {
      step.status = status;
      step.detail = detail;
    }
    emit();
  };

  const abort = (
    id: FlowStepId,
    message: string,
    keepPending: FlowStepId[] = [],
  ): CreateAppResult => {
    update(id, "failed", message);
    for (const step of steps) {
      if (step.status === "pending" && !keepPending.includes(step.id)) {
        step.status = "skipped";
      }
    }
    emit();
    result.error = message;
    return result;
  };

  return { result, update, abort, warn: (message) => result.warnings.push(message) };
}

/**
 * What to do about a repository Cloudflare cannot read, worded the same wherever it is
 * found — during the build, or again when the rescue build is asked for.
 */
function repoAccessFix(fullName: string, detail: string, next: string): string {
  return (
    `Cloudflare cannot read ${fullName}, so a push to it will not build. Its GitHub App ` +
    "only reaches repositories it is installed on, and a repository that did not exist " +
    "a moment ago is not among them. Add this one at " +
    'https://github.com/settings/installations, or set that installation to "All ' +
    `repositories". ${next} Cloudflare said: ${detail}`
  );
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
    run.update("wait-origin", "running", "Waiting for the first Cloudflare build…");
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
      const hint =
        probe.state === "mismatched"
          ? ""
          : " The repository and the Worker exist, so the build is what to look at:" +
            " Cloudflare, the Worker, Settings, Builds. An empty build list there means" +
            " Cloudflare's GitHub App never saw the repository — set it to" +
            ' "All repositories" at https://github.com/settings/installations, or add' +
            " this one to it, then press Build now.";
      run.abort(
        "wait-origin",
        `${probe.detail || "The app did not come live in time."}${hint}`,
        keepPending,
      );
      return false;
    }
    run.update("wait-origin", "done", `${worker.url} is serving haven-app.json.`);
    return true;
  } catch (error) {
    run.abort(
      "wait-origin",
      readErrorMessage(error, "The app origin could not be checked."),
      keepPending,
    );
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
    run.update("propose", "skipped", "This Haven install did not grant app proposal.");
    run.warn(`Add the app manually in Haven using ${worker.url}`);
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
        run.warn(warning);
      }
      run.update("propose", "done", `${proposed.label} is installed in Haven.`);
    } else if (proposed.reason === "declined") {
      run.update("propose", "skipped", "You declined the install. The app is still deployed.");
      run.warn(`Add the app later in Haven using ${worker.url}`);
    } else {
      const message = proposed.message || "Haven could not read the app definition.";
      run.warn(message);
      run.update("propose", "failed", message);
    }
  } catch (error) {
    const message = readErrorMessage(error, "Haven could not be asked to install the app.");
    run.warn(message);
    run.update("propose", "failed", message);
  }
}

async function runGitHubPhase(
  run: StepRunner,
  input: CreateAppInput,
  deps: CreateAppDependencies,
): Promise<boolean> {
  const { identity, owner } = input;
  const { result, update, abort } = run;

  update("check-name", "running");
  try {
    const existing = await deps.github.getRepository(owner, identity.slug);
    if (existing) {
      abort("check-name", `${existing.fullName} already exists. Choose a different repository name.`);
      return false;
    }
    update("check-name", "done", `${identity.slug} is available.`);
  } catch (error) {
    abort("check-name", readErrorMessage(error, "The repository name could not be checked."));
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
    update("create-repo", "done", repository.fullName);
  } catch (error) {
    abort("create-repo", readErrorMessage(error, "The repository could not be created."));
    return false;
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
    update("commit-identity", "done", `${files.length} files named for ${identity.label}.`);
  } catch (error) {
    abort("commit-identity", readErrorMessage(error, "The app identity could not be committed."));
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
    run.update("check-repo-access", "skipped", "No Cloudflare account to ask.");
    return "unknown";
  }

  run.update("check-repo-access", "running");
  try {
    const readable = await deps.cloudflare.checkRepoReadable(repository);
    if (readable.state === "unreadable") {
      run.update("check-repo-access", "failed", readable.detail);
      return "unreadable";
    }
    run.update(
      "check-repo-access",
      "done",
      readable.state === "readable" ? readable.detail : `Not confirmed: ${readable.detail}`,
    );
    return readable.state === "readable" ? "readable" : "unknown";
  } catch (error) {
    // A check that could not run says nothing about the build, so it must not colour
    // one. This is the same reasoning as `unknown` inside the check itself.
    run.update("check-repo-access", "done", readErrorMessage(error, "Could not be checked."));
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
  let unreadable: string | null = null;
  if (access === "unreadable") {
    unreadable = repoAccessFix(
      repository.fullName,
      run.result.steps.find((step) => step.id === "check-repo-access")?.detail ||
        "Repository not found",
      "Then press Start first build — the Worker can still be wired without a push.",
    );
    warn(unreadable);
  }

  let worker: WorkerDeployment;
  try {
    update("create-worker", "running");
    worker = await deps.cloudflare.ensureWorker({ name: identity.slug });
    result.worker = worker;
    update("create-worker", "done", worker.reused ? `${worker.url} (existing)` : worker.url);
  } catch (error) {
    abort("create-worker", readErrorMessage(error, "The Worker could not be created."), keepPending);
    return false;
  }

  try {
    update("connect-builds", "running");
    const connected = await deps.cloudflare.connectPushToDeploy({ repository, worker });
    update("connect-builds", "done", connected.detail);
  } catch (error) {
    abort(
      "connect-builds",
      readErrorMessage(error, "Push-to-deploy could not be configured."),
      keepPending,
    );
    return false;
  }

  if (unreadable) {
    update("start-build", "skipped", "No build can run until Cloudflare can read the repository.");
    update("wait-origin", "skipped", "No build can run until Cloudflare can read the repository.");
    update("propose", "skipped", "Haven reads the app definition from the live URL.");
    result.error = unreadable;
    return true;
  }

  if (!deps.cloudflare.startBuild) {
    update("start-build", "skipped", "No way to start a build without a push.");
  } else {
    try {
      update("start-build", "running");
      const started = await deps.cloudflare.startBuild({
        worker,
        branch: repository.defaultBranch,
      });
      update("start-build", "done", started.detail);
    } catch (error) {
      abort("start-build", readErrorMessage(error, "The build could not be started."), keepPending);
      return false;
    }
  }

  if (!(await awaitOrigin(run, deps, worker, identity.slug, keepPending))) {
    return false;
  }

  if (input.skipPropose) {
    run.update("propose", "skipped", "Press Register in Haven when you are ready.");
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
    run.update("launch-agent", "skipped", "No Cursor API key connected.");
    return;
  }

  try {
    run.update("launch-agent", "running");
    const agent = await deps.cursor.launchAgent({ repository });
    run.result.agent = agent;
    run.update("launch-agent", "done", agent.url);
  } catch (error) {
    const message = readErrorMessage(error, "The Cursor agent could not be started.");
    run.warn(message);
    run.update("launch-agent", "failed", message);
  }
}

/** Create the GitHub repository and write its identity. The Cloudflare page starts later. */
export async function createGitHubProject(
  input: CreateAppInput,
  deps: CreateAppDependencies,
): Promise<CreateAppResult> {
  const run = createRunner(createGitHubPhaseSteps(), deps.onStep);
  await runGitHubPhase(run, input, deps);
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

  if (!(await runGitHubPhase(run, input, deps))) {
    return run.result;
  }

  const repository = run.result.repository!;
  await runCloudflarePhase(run, { identity: input.identity, repository }, deps, [
    "launch-agent",
  ]);

  if (repository) {
    await runCursorPhase(run, repository, deps);
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
    const detail =
      result.steps.find((step) => step.id === "check-repo-access")?.detail || "Repository not found";
    return run.abort(
      "check-repo-access",
      repoAccessFix(repository.fullName, detail, "Then press Build now again."),
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
    return run.abort("start-build", readErrorMessage(error, "The build could not be started."));
  }

  if (!(await awaitOrigin(run, deps, worker, input.appId))) {
    return result;
  }

  await proposeToHaven(run, deps, worker);

  return result;
}
