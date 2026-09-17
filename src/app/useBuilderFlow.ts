/**
 * Wires the framework-free pieces into something a Vue component can render.
 *
 * The interesting decision here is *where* each call is made:
 *
 * - **GitHub in the browser.** Its API is CORS-open, so the user's token is used by the
 *   page that holds it and never passes through anything Mindoo runs.
 * - **Cloudflare and Cursor through the host.** Cursor's API is server-side only and
 *   Cloudflare's does not promise CORS, so those go through `/api/*` — one token, one
 *   call, nothing stored.
 * - **Haven over the bridge.** Installing the finished app is `proposeApp(url)`, and
 *   Haven fetches and validates that origin itself.
 */
import { computed, ref, type Ref } from "vue";

import {
  slugifyAppName,
  isValidSlug,
  type AppIdentity,
} from "@/core/appIdentity";
import { isCloudflareTokenStale } from "@/core/credentials";
import {
  CLOUDFLARE_PHASE_STEP_IDS,
  CURSOR_PHASE_STEP_IDS,
  GITHUB_PHASE_STEP_IDS,
  createCloudflarePhaseSteps,
  createCursorPhaseSteps,
  createDeployNowSteps,
  createGitHubPhaseSteps,
  createGitHubProject as runCreateGitHubProject,
  createInitialSteps,
  createRegisterHavenSteps,
  deployNow as runDeployNow,
  deployToCloudflare as runDeployToCloudflare,
  launchCursorWork as runLaunchCursorWork,
  registerInHaven as runRegisterInHaven,
  type AgentHandle,
  type CreateAppResult,
  type DeployNowDependencies,
  type FlowStep,
  type FlowStepId,
} from "@/core/createAppFlow";
import {
  commitFiles,
  generateRepositoryFromTemplate,
  getFileText,
  getRepository,
  type GitHubRepository,
} from "@/core/github";
import { waitForOrigin } from "@/core/originProbe";
import {
  checkCloudflareRepoReadable,
  connectCloudflarePushToDeploy,
  ensureCloudflareWorker,
  launchCursorAgent,
  refreshCloudflareTokenViaHost,
  startCloudflareBuild,
  type BuilderHostConfig,
} from "@/app/hostApi";
import type { useBuilderSession } from "@/app/useBuilderSession";

export interface NewAppForm {
  label: string;
  slug: string;
  /** True while the user has not edited the slug, so it keeps following the label. */
  slugFollowsLabel: boolean;
  description: string;
  task: string;
  private: boolean;
}

export function createEmptyForm(): NewAppForm {
  return {
    label: "",
    slug: "",
    slugFollowsLabel: true,
    description: "",
    task: "",
    // Private by default. An unfinished app's plan is in TASK.md from the first commit,
    // and the cost of publishing it by accident is not symmetric with the cost of
    // clicking a checkbox.
    private: true,
  };
}

type BuilderSession = ReturnType<typeof useBuilderSession>;

export function useBuilderFlow(
  session: BuilderSession,
  hostConfig?: Ref<BuilderHostConfig | null>,
) {
  const form = ref<NewAppForm>(createEmptyForm());
  const steps = ref<FlowStep[]>(createInitialSteps());
  const running = ref(false);
  const result = ref<CreateAppResult | null>(null);
  const agent = ref<AgentHandle | null>(null);
  /** Survives later phase step lists that no longer include `wait-origin`. */
  const originReady = ref(false);
  const wiredForBuild = ref(false);

  const identity = computed<AppIdentity>(() => ({
    label: form.value.label.trim(),
    slug: form.value.slug.trim() || slugifyAppName(form.value.label),
    description: form.value.description.trim(),
    task: form.value.task,
  }));

  /** Shown live under the repository field: this is the URL the app will get. */
  const plannedRepositoryName = computed(() => identity.value.slug);

  const formError = computed(() => {
    if (!identity.value.label) {
      return "The app needs a name.";
    }
    if (!isValidSlug(identity.value.slug)) {
      return "The repository name may only contain lowercase letters, digits, and dashes.";
    }
    return null;
  });

  const identityValid = computed(() => formError.value === null);

  const githubError = computed(() => {
    if (formError.value) {
      return formError.value;
    }
    if (!session.credentialsStatus.value.github) {
      return "Connect GitHub first.";
    }
    return null;
  });

  const cloudflareError = computed(() => {
    if (!session.credentialsStatus.value.github) {
      return "Connect GitHub first.";
    }
    if (!session.credentialsStatus.value.cloudflare) {
      return "Connect Cloudflare first.";
    }
    if (!result.value?.repository) {
      return "Create the GitHub repository first, or skip back if it already exists.";
    }
    return null;
  });

  const cursorError = computed(() => {
    if (!result.value?.repository) {
      return "Create the GitHub repository first.";
    }
    if (!session.credentialsStatus.value.cursor) {
      return "Paste a Cursor API key to start an agent.";
    }
    return null;
  });

  const canCreateRepo = computed(() => githubError.value === null && !running.value);
  const canDeploy = computed(() => cloudflareError.value === null && !running.value);
  const canRegisterHaven = computed(
    () => Boolean(result.value?.worker) && originReady.value && !running.value,
  );
  const canLaunchCursor = computed(() => cursorError.value === null && !running.value);

  function stepsIn(ids: readonly FlowStepId[]): FlowStep[] {
    return steps.value.filter((step) => ids.includes(step.id));
  }

  const githubSteps = computed(() => stepsIn(GITHUB_PHASE_STEP_IDS));
  /*
   * The rescue run's ids (`deployNow`) are a subset of the phase's, so the phase list
   * alone covers both. It used to append `check-repo-access` and `start-build`, which
   * read as though the phase were missing them.
   */
  const cloudflareSteps = computed(() => stepsIn(CLOUDFLARE_PHASE_STEP_IDS));
  const cursorSteps = computed(() => stepsIn(CURSOR_PHASE_STEP_IDS));

  /** Keep the slug in step with the name until the user takes it over. */
  function onLabelInput(label: string): void {
    form.value.label = label;
    if (form.value.slugFollowsLabel) {
      form.value.slug = slugifyAppName(label);
    }
  }

  function onSlugInput(slug: string): void {
    form.value.slug = slug;
    form.value.slugFollowsLabel = false;
  }

  function buildDependencies(): DeployNowDependencies {
    const credentials = session.credentials.value;
    const githubToken = credentials.githubToken;
    const owner = credentials.githubOwner;

    return {
      github: {
        getRepository: (repoOwner, name) =>
          getRepository(githubToken, repoOwner || owner, name),
        generateFromTemplate: (input) =>
          generateRepositoryFromTemplate({
            token: githubToken,
            owner,
            name: input.name,
            description: input.description,
            private: input.private,
          }),
        readTemplateSources: async (repository: GitHubRepository) => {
          const read = async (path: string) => {
            const text = await getFileText({
              token: githubToken,
              owner: repository.owner,
              repo: repository.name,
              path,
              ref: repository.defaultBranch,
            });
            if (text === null) {
              throw new Error(`The template is missing ${path}.`);
            }
            return text;
          };
          const [packageJson, wranglerConfig, appDefinition] = await Promise.all([
            read("package.json"),
            read("wrangler.jsonc"),
            read("public/haven-app.json"),
          ]);
          return { packageJson, wranglerConfig, appDefinition };
        },
        commitFiles: (input) =>
          commitFiles({
            token: githubToken,
            owner: input.repository.owner,
            repo: input.repository.name,
            branch: input.repository.defaultBranch,
            message: input.message,
            files: input.files,
          }),
      },
      // Both Cloudflare calls go out through the host, which is the only place they can
      // go: the API answers browsers with no CORS headers at all.
      cloudflare: {
        ensureWorker: ({ name }) =>
          ensureCloudflareWorker({
            cloudflareToken: credentials.cloudflareToken,
            accountId: credentials.cloudflareAccountId,
            name,
          }),
        // The ids are GitHub's, read here for the same reason as below: the host needs
        // them to ask Cloudflare, and they are not secret.
        checkRepoReadable: (repository) =>
          checkCloudflareRepoReadable({
            cloudflareToken: credentials.cloudflareToken,
            accountId: credentials.cloudflareAccountId,
            providerAccountId: String(repository.ownerId),
            repoId: String(repository.id),
            branch: repository.defaultBranch,
          }),
        startBuild: async ({ worker, branch }) => {
          const build = await startCloudflareBuild({
            cloudflareToken: credentials.cloudflareToken,
            accountId: credentials.cloudflareAccountId,
            scriptTag: worker.scriptTag,
            branch,
          });
          return { detail: `Cloudflare is building ${branch} (${build.buildUuid}).` };
        },
        connectPushToDeploy: async ({ repository, worker }) => {
          const connection = await connectCloudflarePushToDeploy({
            cloudflareToken: credentials.cloudflareToken,
            accountId: credentials.cloudflareAccountId,
            // GitHub's own ids, read here where the GitHub token is. They are not
            // secret, so the host learns nothing it could misuse.
            providerAccountId: String(repository.ownerId),
            providerAccountName: repository.owner,
            repoId: String(repository.id),
            repoName: repository.name,
            scriptTag: worker.scriptTag,
            branch: repository.defaultBranch,
          });
          return {
            detail: connection.reused
              ? `Reusing the existing build trigger for ${repository.name}.`
              : `Pushes to ${repository.defaultBranch} now deploy themselves.`,
          };
        },
      },
      waitForOrigin: (input) =>
        waitForOrigin({
          url: input.url,
          expectedAppId: input.expectedAppId,
          onAttempt: (probe, attempt) => {
            const step = steps.value.find((entry) => entry.id === "wait-origin");
            if (step && probe.state !== "ready") {
              step.detail = `Attempt ${attempt}: ${probe.detail}`;
              steps.value = [...steps.value];
            }
          },
        }),
      // Omitted entirely rather than passed as a no-op: the flow reports the step as
      // skipped only when the capability is genuinely absent.
      ...(session.credentialsStatus.value.cursor
        ? {
            cursor: {
              launchAgent: async ({ repository }) => {
                const launched = await launchCursorAgent({
                  cursorToken: credentials.cursorToken,
                  repositoryUrl: repository.htmlUrl,
                  branch: repository.defaultBranch,
                });
                return {
                  id: launched.agent.id,
                  url: launched.agent.url,
                  runId: launched.run.id,
                };
              },
            },
          }
        : {}),
      ...(session.canProposeApps.value
        ? { haven: { proposeApp: (url: string) => session.proposeApp(url) } }
        : {}),
      onStep: (next) => {
        steps.value = next;
      },
    };
  }

  /**
   * Renew an OAuth access token that is about to expire.
   *
   * Done before the run rather than in the middle of one: a build takes minutes and
   * discovering the token died between creating the repository and connecting the build
   * would leave half an app behind. A pasted API token has no expiry and is left alone.
   */
  async function refreshCloudflareIfStale(): Promise<void> {
    const credentials = session.credentials.value;
    if (!credentials.cloudflareRefreshToken || !isCloudflareTokenStale(credentials)) {
      return;
    }
    try {
      const tokens = await refreshCloudflareTokenViaHost(credentials.cloudflareRefreshToken);
      await session.storeCredentials({
        ...session.credentials.value,
        cloudflareToken: tokens.accessToken,
        cloudflareRefreshToken: tokens.refreshToken,
        cloudflareExpiresAt: tokens.expiresAt ?? 0,
      });
    } catch {
      // Left to fail on the first real call, which reports Cloudflare's own wording and
      // tells the user to connect again.
    }
  }

  function mergeOutcome(next: CreateAppResult): void {
    if (next.steps.some((step) => step.id === "wait-origin" && step.status === "done")) {
      originReady.value = true;
    }
    if (next.steps.some((step) => step.id === "connect-builds" && step.status === "done")) {
      wiredForBuild.value = true;
    }
    const previous = result.value;
    result.value = {
      ...next,
      repository: next.repository ?? previous?.repository ?? null,
      worker: next.worker ?? previous?.worker ?? null,
      agent: next.agent ?? previous?.agent ?? null,
      installedAppInstanceId:
        next.installedAppInstanceId ?? previous?.installedAppInstanceId ?? null,
      warnings: [...(previous?.warnings ?? []), ...next.warnings],
    };
    agent.value = result.value.agent;
    steps.value = next.steps.map((step) => ({ ...step }));
  }

  async function createGitHubProject(): Promise<void> {
    if (!canCreateRepo.value) {
      return;
    }
    running.value = true;
    steps.value = createGitHubPhaseSteps();

    try {
      mergeOutcome(
        await runCreateGitHubProject(
          {
            identity: identity.value,
            owner: session.credentials.value.githubOwner,
            private: form.value.private,
          },
          buildDependencies(),
        ),
      );
    } finally {
      running.value = false;
    }
  }

  async function deployCloudflare(): Promise<void> {
    const repository = result.value?.repository;
    if (!canDeploy.value || !repository) {
      return;
    }
    await refreshCloudflareIfStale();
    running.value = true;
    steps.value = createCloudflarePhaseSteps();

    try {
      mergeOutcome(
        await runDeployToCloudflare(
          {
            identity: identity.value,
            repository,
            worker: result.value?.worker,
            skipPropose: true,
          },
          buildDependencies(),
        ),
      );
    } finally {
      running.value = false;
    }
  }

  async function registerHaven(): Promise<void> {
    const worker = result.value?.worker;
    if (!canRegisterHaven.value || !worker) {
      return;
    }
    running.value = true;
    steps.value = createRegisterHavenSteps();

    try {
      mergeOutcome(
        await runRegisterInHaven(
          { worker, repository: result.value?.repository },
          buildDependencies(),
        ),
      );
    } finally {
      running.value = false;
    }
  }

  async function launchCursor(): Promise<void> {
    const repository = result.value?.repository;
    if (!canLaunchCursor.value || !repository) {
      return;
    }
    running.value = true;
    steps.value = createCursorPhaseSteps();

    try {
      mergeOutcome(
        await runLaunchCursorWork(
          { repository, agent: result.value?.agent },
          buildDependencies(),
        ),
      );
    } finally {
      running.value = false;
    }
  }

  /**
   * Offered when an app was fully wired but never built.
   *
   * The distinction that matters is `connect-builds`: a build belongs to a trigger, and
   * without one there is nothing to start. A finished `wait-origin` means the app is
   * already live and the button would be noise.
   */
  const canBuildNow = computed(() => {
    const outcome = result.value;
    if (!outcome || !outcome.repository || !outcome.worker || originReady.value) {
      return false;
    }
    return wiredForBuild.value;
  });

  /**
   * Build the app that never built, and carry on where the first run stopped.
   *
   * Stays offered while it runs — disabled, not hidden — because a button that vanishes
   * on click makes the user wonder whether it registered.
   *
   * The app id comes from the repository rather than from the form, which the user may
   * have edited since — the repository name *is* the app id the first run committed.
   */
  async function buildNow(): Promise<void> {
    const outcome = result.value;
    if (!canBuildNow.value || running.value || !outcome?.repository || !outcome.worker) {
      return;
    }
    await refreshCloudflareIfStale();
    running.value = true;
    steps.value = createDeployNowSteps();

    try {
      const next = await runDeployNow(
        {
          repository: outcome.repository,
          worker: outcome.worker,
          appId: outcome.repository.name,
          agent: outcome.agent,
        },
        buildDependencies(),
      );
      result.value = next;
      agent.value = next.agent;
      steps.value = next.steps.map((step) => ({ ...step }));
    } finally {
      running.value = false;
    }
  }

  function reset(): void {
    form.value = createEmptyForm();
    steps.value = createInitialSteps();
    result.value = null;
    agent.value = null;
    originReady.value = false;
    wiredForBuild.value = false;
  }

  return {
    agent,
    buildNow,
    canBuildNow,
    canCreateRepo,
    canDeploy,
    canLaunchCursor,
    canRegisterHaven,
    cloudflareError,
    cloudflareSteps,
    createGitHubProject,
    cursorError,
    cursorSteps,
    githubSteps,
    deployCloudflare,
    form,
    formError,
    githubError,
    identity,
    identityValid,
    launchCursor,
    onLabelInput,
    onSlugInput,
    originReady,
    plannedRepositoryName,
    registerHaven,
    reset,
    result,
    running,
    steps,
  };
}
