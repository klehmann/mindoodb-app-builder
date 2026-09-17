/**
 * The build, as a sequence of named steps.
 *
 * Nine things have to happen, in an order that is not arbitrary. The first two are
 * precondition checks, deliberately ahead of every side effect: failing there costs
 * nothing, while failing after the Worker exists leaves debris in the user's Cloudflare
 * account and a repository name that is already taken.
 *
 *  1. **check-name** — is the repository name free?
 *  1b. **check-deploy-access** — can Cloudflare's GitHub App read a repository that does
 *     not exist yet? If it is limited to selected repositories, it cannot, and
 *     push-to-deploy would be accepted and then silently never build.
 *  2. **create-repo** — copy the starter template.
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
import type { CloudflareRepoAccess, GitHubRepository } from "./github";
import type { OriginProbeResult } from "./originProbe";

export type FlowStepId =
  | "check-name"
  | "check-deploy-access"
  | "create-repo"
  | "create-worker"
  | "connect-builds"
  | "commit-identity"
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
  "check-deploy-access",
  "create-repo",
  "create-worker",
  "connect-builds",
  "commit-identity",
  "wait-origin",
  "launch-agent",
  "propose",
];

export function createInitialSteps(): FlowStep[] {
  return FLOW_STEP_IDS.map((id) => ({ id, status: "pending", detail: "" }));
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
    /**
     * Whether Cloudflare's GitHub App will be able to read a repository that does not
     * exist yet. Optional: a token that cannot answer leaves the check unmade rather
     * than blocking the build.
     */
    checkCloudflareRepoAccess?: () => Promise<CloudflareRepoAccess>;
    readTemplateSources: (repository: GitHubRepository) => Promise<TemplateSources>;
    commitFiles: (input: {
      repository: GitHubRepository;
      message: string;
      files: Array<{ path: string; content: string }>;
    }) => Promise<string>;
  };
  cloudflare: {
    ensureWorker: (input: { name: string }) => Promise<WorkerDeployment>;
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
  const steps = createInitialSteps();
  const warnings: string[] = [];

  const result: CreateAppResult = {
    steps,
    repository: null,
    worker: null,
    agent: null,
    installedAppInstanceId: null,
    warnings,
    error: null,
  };

  function update(id: FlowStepId, status: FlowStepStatus, detail = ""): void {
    const step = steps.find((entry) => entry.id === id);
    if (step) {
      step.status = status;
      step.detail = detail;
    }
    deps.onStep?.(steps.map((entry) => ({ ...entry })));
  }

  /** Mark the flow as stopped: the failing step keeps its reason, the rest are skipped. */
  function abort(id: FlowStepId, message: string): CreateAppResult {
    update(id, "failed", message);
    for (const step of steps) {
      if (step.status === "pending") {
        step.status = "skipped";
      }
    }
    deps.onStep?.(steps.map((entry) => ({ ...entry })));
    result.error = message;
    return result;
  }

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

  /*
   * 1b. Can Cloudflare read what we are about to create?
   *
   * Placed before the first side effect on purpose. Cloudflare accepts the connection
   * for a repository its GitHub App cannot see, so the failure otherwise surfaces four
   * steps later as an origin that never answers — by which time the repository exists,
   * its name is taken, and the user has to work out which of seven steps lied.
   */
  if (deps.github.checkCloudflareRepoAccess) {
    update("check-deploy-access", "running");
    try {
      const access = await deps.github.checkCloudflareRepoAccess();
      if (access.state === "selected") {
        return abort(
          "check-deploy-access",
          "Cloudflare's GitHub App is limited to selected repositories, so it will not " +
            "be able to read this one — a repository that does not exist yet cannot be " +
            `in that list. Set it to "All repositories" at ${access.settingsUrl}, then ` +
            "start again. Nothing has been created yet.",
        );
      }
      if (access.state === "missing") {
        return abort(
          "check-deploy-access",
          "Cloudflare's GitHub App is not installed, so no push could ever reach " +
            `Cloudflare. Install it at ${access.installUrl} — or in the Cloudflare ` +
            "dashboard under any Worker, Settings, Builds, Connect — then start again.",
        );
      }
      update(
        "check-deploy-access",
        "done",
        access.state === "all"
          ? "Cloudflare can read new repositories."
          : "Could not be checked; continuing.",
      );
    } catch (error) {
      // Never fatal: this is a courtesy check, and a build that would have worked must
      // not be stopped because one extra lookup failed.
      update(
        "check-deploy-access",
        "done",
        readErrorMessage(error, "Could not be checked; continuing."),
      );
    }
  } else {
    update("check-deploy-access", "skipped", "No GitHub installation to check.");
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

  // 6. Wait for the build to publish the origin.
  try {
    update("wait-origin", "running", "Waiting for the first Cloudflare build…");
    const probe = await deps.waitForOrigin({ url: worker.url, expectedAppId: identity.slug });
    if (probe.state !== "ready") {
      // A silent origin means the build did not publish, and the reason for that lives
      // in Cloudflare's build log — not in anything this builder can see. Saying so
      // beats repeating that the origin is quiet, which the user already knows.
      const hint =
        probe.state === "mismatched"
          ? ""
          : " The repository and the Worker exist, so the build is what to look at:" +
            " Cloudflare, the Worker, Settings, Builds.";
      return abort(
        "wait-origin",
        `${probe.detail || "The app did not come live in time."}${hint}`,
      );
    }
    update("wait-origin", "done", `${worker.url} is serving haven-app.json.`);
  } catch (error) {
    return abort("wait-origin", readErrorMessage(error, "The app origin could not be checked."));
  }

  // 7. Cursor agent. Optional, and never fatal: the app is built and live already.
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

  // 8. Hand it to Haven.
  if (!deps.haven) {
    update("propose", "skipped", "This Haven install did not grant app proposal.");
    warnings.push(`Add the app manually in Haven using ${worker.url}`);
    return result;
  }

  try {
    update("propose", "running");
    const proposed = await deps.haven.proposeApp(worker.url);
    if (proposed.ok) {
      result.installedAppInstanceId = proposed.appInstanceId;
      warnings.push(...proposed.warnings);
      update("propose", "done", `${proposed.label} is installed in Haven.`);
    } else if (proposed.reason === "declined") {
      update("propose", "skipped", "You declined the install. The app is still deployed.");
      warnings.push(`Add the app later in Haven using ${worker.url}`);
    } else {
      const message = proposed.message || "Haven could not read the app definition.";
      warnings.push(message);
      update("propose", "failed", message);
    }
  } catch (error) {
    const message = readErrorMessage(error, "Haven could not be asked to install the app.");
    warnings.push(message);
    update("propose", "failed", message);
  }

  return result;
}
