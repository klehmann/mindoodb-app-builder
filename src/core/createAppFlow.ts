/**
 * The build, as a sequence of named steps.
 *
 * Eight things have to happen, in an order that is not arbitrary. The first is a
 * precondition check, deliberately ahead of every side effect: failing there costs
 * nothing, while failing after the Worker exists leaves debris in the user's Cloudflare
 * account and a repository name that is already taken.
 *
 *  1. **check-name** — is the repository name free?
 *  2. **create-repo** — copy the starter template.
 *  2b. **check-repo-access** — ask Cloudflare to read the new repository. A refusal is
 *     reported and does not stop the flow, because the repository already exists; see
 *     the step itself for why aborting would be the worse answer.
 *  3. **create-worker** — a placeholder Worker, so the URL exists and Cloudflare has an
 *     immutable script tag. No clone, no install, no build: the real build happens in
 *     Cloudflare's CI, which is also what every later push will use.
 *  4. **connect-builds** — wire push-to-deploy. Before the identity commit, so that
 *     commit *is* the first deploy rather than needing a second push to wake CI up.
 *  5. **commit-identity** — name the app in the four files that carry its identity and
 *     write the user's description into `TASK.md`. This push triggers the first build.
 *  6. **wait-origin** — poll `haven-app.json` until it is really being served. Haven's
 *     install reads the same file, so a pass here is evidence rather than a guess.
 *  7. **launch-agent** — hand the repository to a Cursor cloud agent. Non-fatal: the app
 *     exists and is deployed either way, and the user can start an agent by hand.
 *  8. **propose** — ask Haven to install it. The user still approves in Haven's own
 *     dialog; a decline is an answer, not an error.
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
  | "check-repo-access"
  | "create-worker"
  | "connect-builds"
  | "commit-identity"
  | "start-build"
  | "wait-origin"
  | "launch-agent"
  | "propose";

export type FlowStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface FlowStep {
  id: FlowStepId;
  status: FlowStepStatus;
  /** One line for the user: what happened, or why it did not. */
  detail: string;
}

export const FLOW_STEP_IDS: FlowStepId[] = [
  "check-name",
  "create-repo",
  "check-repo-access",
  "create-worker",
  "connect-builds",
  "commit-identity",
  "wait-origin",
  "launch-agent",
  "propose",
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

function createSteps(ids: FlowStepId[]): FlowStep[] {
  return ids.map((id) => ({ id, status: "pending", detail: "" }));
}

export function createInitialSteps(): FlowStep[] {
  return createSteps(FLOW_STEP_IDS);
}

export function createDeployNowSteps(): FlowStep[] {
  return createSteps(DEPLOY_NOW_STEP_IDS);
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
 * `deployNow` needs one thing `createApp` never does: a way to start a build with no
 * push behind it. Required rather than optional, so the button cannot be offered by a
 * caller that has no way to honour it.
 */
export type DeployNowDependencies = CreateAppDependencies & {
  cloudflare: {
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
 * Step bookkeeping, shared by the two runs so they report the same way.
 *
 * `abort` is the only way a run ends early, and it always leaves the same shape behind:
 * the failing step keeps the reason, later steps say skipped rather than pending, and
 * `error` carries the message the UI shows.
 */
interface StepRunner {
  result: CreateAppResult;
  update: (id: FlowStepId, status: FlowStepStatus, detail?: string) => void;
  abort: (id: FlowStepId, message: string) => CreateAppResult;
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

  const abort = (id: FlowStepId, message: string): CreateAppResult => {
    update(id, "failed", message);
    for (const step of steps) {
      if (step.status === "pending") {
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
      run.abort("wait-origin", `${probe.detail || "The app did not come live in time."}${hint}`);
      return false;
    }
    run.update("wait-origin", "done", `${worker.url} is serving haven-app.json.`);
    return true;
  } catch (error) {
    run.abort("wait-origin", readErrorMessage(error, "The app origin could not be checked."));
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

/**
 * Run the whole sequence.
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
  const { result, update, abort } = run;
  const warnings = result.warnings;

  const { identity, owner } = input;

  // 1. Name check.
  update("check-name", "running");
  try {
    const existing = await deps.github.getRepository(owner, identity.slug);
    if (existing) {
      return abort(
        "check-name",
        `${existing.fullName} already exists. Choose a different repository name.`,
      );
    }
    update("check-name", "done", `${identity.slug} is available.`);
  } catch (error) {
    return abort("check-name", readErrorMessage(error, "The repository name could not be checked."));
  }

  // 2. Repository.
  let repository: GitHubRepository;
  try {
    update("create-repo", "running");
    repository = await deps.github.generateFromTemplate({
      name: identity.slug,
      description: identity.description,
      private: input.private ?? false,
    });
    result.repository = repository;
    update("create-repo", "done", repository.fullName);
  } catch (error) {
    return abort("create-repo", readErrorMessage(error, "The repository could not be created."));
  }

  /*
   * 2b. Can Cloudflare read what was just created?
   *
   * Only answerable once the repository exists, and asked of Cloudflare rather than
   * GitHub — see `checkRepoReadable`. This is the misconfiguration with no other
   * symptom: `PUT /builds/repos/connections` accepts a repository Cloudflare cannot
   * see, the push then reaches nobody, and the account shows a Worker "disconnected
   * from your Git account" with an empty build list.
   *
   * A refusal does not stop the flow, for a reason that is easy to miss: the repository
   * already exists, and aborting here would take its name with it, so the retry after
   * fixing access would fail the name check and the user would be stuck choosing a new
   * name for an app they already created. Instead everything else is wired — Worker,
   * connection, identity commit — so granting access and pushing once finishes the job.
   * What is skipped is the part that provably cannot succeed: waiting for a build that
   * was never triggered, and offering Haven a URL that is not serving yet.
   */
  let unreadable: string | null = null;
  if (deps.cloudflare.checkRepoReadable) {
    update("check-repo-access", "running");
    try {
      const readable = await deps.cloudflare.checkRepoReadable(repository);
      if (readable.state === "unreadable") {
        unreadable = repoAccessFix(
          repository.fullName,
          readable.detail,
          "Then press Build now — everything else is already wired, so no push is needed.",
        );
        warnings.push(unreadable);
        update("check-repo-access", "failed", readable.detail);
      } else {
        update(
          "check-repo-access",
          "done",
          readable.state === "readable" ? readable.detail : `Not confirmed: ${readable.detail}`,
        );
      }
    } catch (error) {
      // A check that could not run says nothing about the build, so it must not colour
      // one. This is the same reasoning as `unknown` inside the check itself.
      update("check-repo-access", "done", readErrorMessage(error, "Could not be checked."));
    }
  } else {
    update("check-repo-access", "skipped", "No Cloudflare account to ask.");
  }

  // 3. Worker. Created before any build exists, purely so the URL and the script tag do.
  let worker: WorkerDeployment;
  try {
    update("create-worker", "running");
    worker = await deps.cloudflare.ensureWorker({ name: identity.slug });
    result.worker = worker;
    update("create-worker", "done", worker.reused ? `${worker.url} (existing)` : worker.url);
  } catch (error) {
    return abort("create-worker", readErrorMessage(error, "The Worker could not be created."));
  }

  // 4. Push-to-deploy, before the first push.
  try {
    update("connect-builds", "running");
    const connected = await deps.cloudflare.connectPushToDeploy({ repository, worker });
    update("connect-builds", "done", connected.detail);
  } catch (error) {
    // Not fatal in principle — but without it nothing would ever deploy, so the app
    // would never come live and step 6 would only time out. Stop here and say why.
    return abort(
      "connect-builds",
      readErrorMessage(error, "Push-to-deploy could not be configured."),
    );
  }

  // 5. Identity commit — the push that starts the first build.
  try {
    update("commit-identity", "running");
    const sources = await deps.github.readTemplateSources(repository);
    const files = buildIdentityFiles(sources, identity);
    await deps.github.commitFiles({
      repository,
      message: `chore: set up ${identity.label}`,
      files,
    });
    update("commit-identity", "done", `${files.length} files named for ${identity.label}.`);
  } catch (error) {
    return abort(
      "commit-identity",
      readErrorMessage(error, "The app identity could not be committed."),
    );
  }

  // 6. Wait for the build to publish the origin — unless it provably cannot appear.
  if (unreadable) {
    update("wait-origin", "skipped", "No build can run until Cloudflare can read the repository.");
  } else if (!(await awaitOrigin(run, deps, worker, identity.slug))) {
    return result;
  }

  // 7. Cursor agent. Optional, and never fatal: it works on the repository, which exists
  // whether or not Cloudflare managed to deploy it.
  if (!deps.cursor) {
    update("launch-agent", "skipped", "No Cursor API key connected.");
  } else {
    try {
      update("launch-agent", "running");
      const agent = await deps.cursor.launchAgent({ repository });
      result.agent = agent;
      update("launch-agent", "done", agent.url);
    } catch (error) {
      const message = readErrorMessage(error, "The Cursor agent could not be started.");
      warnings.push(message);
      update("launch-agent", "failed", message);
    }
  }

  // 8. Hand it to Haven, which reads the definition from the URL — so something has to
  // be serving it. The repository, the Worker and the connection are all in place, and
  // the error says the one thing left to do.
  if (unreadable) {
    update("propose", "skipped", "Haven reads the app definition from the live URL.");
    result.error = unreadable;
    return result;
  }

  await proposeToHaven(run, deps, worker);

  return result;
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
 * App could read it, so the identity commit triggered nothing. Once access is granted
 * there is no push left to make — the commit is already in the repository — and the app
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

  if (deps.cloudflare.checkRepoReadable) {
    update("check-repo-access", "running");
    try {
      const readable = await deps.cloudflare.checkRepoReadable(repository);
      if (readable.state === "unreadable") {
        return run.abort(
          "check-repo-access",
          repoAccessFix(repository.fullName, readable.detail, "Then press Build now again."),
        );
      }
      update(
        "check-repo-access",
        "done",
        readable.state === "readable" ? readable.detail : `Not confirmed: ${readable.detail}`,
      );
    } catch (error) {
      // Same reasoning as in `createApp`: a check that could not run says nothing, and
      // must not stand between the user and a build that may well work.
      update("check-repo-access", "done", readErrorMessage(error, "Could not be checked."));
    }
  } else {
    update("check-repo-access", "skipped", "No Cloudflare account to ask.");
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
