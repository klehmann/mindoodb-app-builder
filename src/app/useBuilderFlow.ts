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
  APP_DATABASE_PERMISSIONS,
  DEFAULT_APP_DATABASE_PERMISSIONS,
  databaseIdFromSlug,
  isValidDatabaseId,
  isValidSlug,
  normalizeDatabaseIdInput,
  resolveAppDatabase,
  slugifyAppName,
  type AppDatabasePermission,
  type AppIdentity,
} from "@/core/appIdentity";
import { isCloudflareTokenStale } from "@/core/credentials";
import {
  CLOUDFLARE_PHASE_STEP_IDS,
  CURSOR_PHASE_STEP_IDS,
  GITHUB_PHASE_STEP_IDS,
  createApp as runCreateApp,
  createCloudflarePhaseSteps,
  createCursorPhaseSteps,
  createDeployNowSteps,
  createGitHubPhaseSteps,
  createGitHubProject as runCreateGitHubProject,
  createInitialSteps,
  createRegisterHavenSteps,
  deployNow as runDeployNow,
  deployToCloudflare as runDeployToCloudflare,
  FlowNoteError,
  launchCursorWork as runLaunchCursorWork,
  registerInHaven as runRegisterInHaven,
  type AgentHandle,
  type CreateAppResult,
  type DeployNowDependencies,
  type FlowNote,
  type FlowStep,
  type FlowStepId,
} from "@/core/createAppFlow";
import {
  nextAppAction,
  repositoryFromRecord,
  workerFromRecord,
  type StoredAppRecord,
} from "@/core/appRecords";
import type { useAppRecords } from "@/app/useAppRecords";
import {
  commitFiles,
  generateRepositoryFromTemplate,
  getFileText,
  getRepository,
  waitForRepositoryContent,
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
import { t } from "@/i18n";

export interface NewAppForm {
  label: string;
  slug: string;
  /** True while the user has not edited the slug, so it keeps following the label. */
  slugFollowsLabel: boolean;
  description: string;
  task: string;
  private: boolean;
  databaseId: string;
  databaseLabel: string;
  /** True while the database id still tracks the slug as `app_<slug>`. */
  databaseIdFollowsSlug: boolean;
  /** True while the readable database name still tracks the app name. */
  databaseLabelFollowsLabel: boolean;
  permissions: AppDatabasePermission[];
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
    databaseId: "",
    databaseLabel: "",
    databaseIdFollowsSlug: true,
    databaseLabelFollowsLabel: true,
    permissions: [...DEFAULT_APP_DATABASE_PERMISSIONS],
  };
}

export { APP_DATABASE_PERMISSIONS };

type BuilderSession = ReturnType<typeof useBuilderSession>;
type AppRecords = ReturnType<typeof useAppRecords>;

export function useBuilderFlow(
  session: BuilderSession,
  hostConfig?: Ref<BuilderHostConfig | null>,
  /**
   * Where a run writes itself down. Optional so the flow stays testable on its own, and
   * so a builder database without write access still builds apps — it just forgets them.
   */
  records?: AppRecords,
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
    databaseId: form.value.databaseId.trim(),
    databaseLabel: form.value.databaseLabel.trim(),
    databasePermissions: [...form.value.permissions],
  }));

  /**
   * Shown live under the repository field: this is the URL the app will get. Empty until
   * the user has actually named something.
   *
   * `identity.slug` is never empty — `slugifyAppName` falls back to a usable name so that
   * an emoji-only label still produces a valid Worker name. That safety net belongs in
   * the name the app is created with, but not in copy: presenting it before the user has
   * typed anything reads as though they had already chosen it.
   */
  const plannedRepositoryName = computed(() => {
    const typedLabel = form.value.label.trim() !== "";
    // A slug the user edited counts on its own. One that is still following the label
    // cannot be trusted: `onLabelInput` keeps it in step by writing `slugifyAppName`'s
    // output, so clearing the name leaves the fallback behind in the field.
    const typedSlug = !form.value.slugFollowsLabel && form.value.slug.trim() !== "";
    return typedLabel || typedSlug ? identity.value.slug : "";
  });

  const formError = computed(() => {
    if (!identity.value.label) {
      return t("flow.validation.nameRequired");
    }
    if (!isValidSlug(identity.value.slug)) {
      return t("flow.validation.slugInvalid");
    }
    if (!isValidDatabaseId(resolveAppDatabase(identity.value).id)) {
      return t("flow.validation.databaseIdInvalid");
    }
    return null;
  });

  const identityValid = computed(() => formError.value === null);

  const githubError = computed(() => {
    if (formError.value) {
      return formError.value;
    }
    if (!session.credentialsStatus.value.github) {
      return t("flow.ready.connectGithub");
    }
    return null;
  });

  const cloudflareError = computed(() => {
    if (!session.credentialsStatus.value.github) {
      return t("flow.ready.connectGithub");
    }
    if (!session.credentialsStatus.value.cloudflare) {
      return t("flow.ready.connectCloudflare");
    }
    if (!result.value?.repository) {
      return t("flow.ready.createRepositoryOrSkipBack");
    }
    return null;
  });

  const cursorError = computed(() => {
    if (!result.value?.repository) {
      return t("flow.ready.createRepository");
    }
    if (!session.credentialsStatus.value.cursor) {
      return t("flow.ready.pasteCursorKey");
    }
    return null;
  });

  /**
   * What stops the one button from working. Cursor is deliberately absent: the app is
   * created, published and installed without it, and the agent step is the one a user
   * can skip or come back to.
   */
  const createAppError = computed(() => {
    if (formError.value) {
      return formError.value;
    }
    // The setup page is named by interpolating its own link label rather than spelling
    // it out here: the two drifted apart once already (this said "Setup" long after the
    // footer link became "Connections and setup"), and a translator cannot catch that.
    const setup = t("app.footer.setupLink");
    if (!session.credentialsStatus.value.github) {
      return t("flow.ready.githubNotConnected", { setup });
    }
    if (!session.credentialsStatus.value.cloudflare) {
      return t("flow.ready.cloudflareNotConnected", { setup });
    }
    return null;
  });

  const canCreateApp = computed(() => createAppError.value === null && !running.value);

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

  function syncFollowedDatabaseFields(): void {
    if (form.value.databaseLabelFollowsLabel) {
      form.value.databaseLabel = form.value.label.trim();
    }
    if (form.value.databaseIdFollowsSlug) {
      const slug = form.value.slug.trim();
      form.value.databaseId = slug ? databaseIdFromSlug(slug) : "";
    }
  }

  /** Keep the slug in step with the name until the user takes it over. */
  function onLabelInput(label: string): void {
    form.value.label = label;
    if (form.value.slugFollowsLabel) {
      form.value.slug = slugifyAppName(label);
    }
    syncFollowedDatabaseFields();
  }

  function onSlugInput(slug: string): void {
    form.value.slug = slug;
    form.value.slugFollowsLabel = false;
    syncFollowedDatabaseFields();
  }

  function onDatabaseIdInput(value: string): void {
    form.value.databaseId = normalizeDatabaseIdInput(value);
    form.value.databaseIdFollowsSlug = false;
  }

  function onDatabaseLabelInput(value: string): void {
    form.value.databaseLabel = value;
    form.value.databaseLabelFollowsLabel = false;
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
          /*
           * GitHub copies the template *after* answering the create call, so for a second
           * or two the new repository exists and is empty. Reading a file in that window
           * returns 404 "This repository is empty.", which used to surface as "the
           * template is missing package.json" — about a template that was fine.
           */
          const filled = await waitForRepositoryContent({
            token: githubToken,
            owner: repository.owner,
            repo: repository.name,
            ref: repository.defaultBranch,
          });
          if (!filled) {
            /*
             * A note rather than a worded message: this is thrown into the flow, which
             * reports it, and the language it is shown in has to be the language the
             * reader is in then — not the one that happened to be active mid-build. The
             * button it names is filled in at that point too, from the button's own key.
             */
            throw new FlowNoteError({
              code: "templateCopyPending",
              params: { fullName: repository.fullName },
            });
          }

          const read = async (path: string) => {
            const text = await getFileText({
              token: githubToken,
              owner: repository.owner,
              repo: repository.name,
              path,
              ref: repository.defaultBranch,
            });
            if (text === null) {
              throw new FlowNoteError({ code: "templateMissingFile", params: { path } });
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
          /*
           * A code, not a sentence — even though this runs in the browser where `t` is
           * available. A string baked in here freezes in the language that was active
           * when the build started, and Haven can switch language at any time.
           */
          const detail: FlowNote = {
            code: "buildStarted",
            params: { branch, buildUuid: build.buildUuid },
          };
          return { detail };
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
          const detail: FlowNote = connection.reused
            ? { code: "buildTriggerReused", params: { name: repository.name } }
            : { code: "pushToDeployConnected", params: { branch: repository.defaultBranch } };
          return { detail };
        },
      },
      waitForOrigin: (input) =>
        waitForOrigin({
          url: input.url,
          expectedAppId: input.expectedAppId,
          onAttempt: (probe, attempt) => {
            const step = steps.value.find((entry) => entry.id === "wait-origin");
            if (step && probe.state !== "ready") {
              /*
               * The probe's reason is carried as a nested code rather than resolved here,
               * which is what stopped "Versuch 3 — The origin did not answer yet.": an
               * English sentence interpolated into a translated frame.
               */
              step.detail = {
                code: "originAttempt",
                params: {
                  ...(probe.detail?.params ?? {}),
                  attempt,
                  note: probe.detail?.code ?? "originNoAnswer",
                },
              };
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
      /*
       * Save at every phase boundary. The two booleans are read off the steps rather
       * than tracked separately, because the step list is what actually happened: a
       * finished `connect-builds` means a trigger exists, and a finished `wait-origin`
       * means the app really answered on its own URL.
       */
      onPhase: async (next) => {
        await records?.recordPhase({
          repository: next.repository,
          worker: next.worker,
          agent: next.agent,
          installedAppInstanceId: next.installedAppInstanceId,
          cloudflareAccountId: credentials.cloudflareAccountId,
          identityCommitted: next.identityCommitted,
          wiredForBuild: next.steps.some(
            (step) => step.id === "connect-builds" && step.status === "done",
          ),
          originReady: next.steps.some(
            (step) => step.id === "wait-origin" && step.status === "done",
          ),
        });
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

  /**
   * Publish an app whose repository exists.
   *
   * Hands the live URL to Haven at the end rather than waiting for a second button:
   * "publish it, then install it" is one intention, and splitting it into two presses
   * only created a state where the app was live and Haven did not know.
   */
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
   * The whole app, in one press: repository, identity commit, Worker, push-to-deploy,
   * first build, wait for the URL, hand it to Haven, and start the agent if a Cursor key
   * is connected.
   *
   * The phases still exist and still report themselves — the user just does not have to
   * drive them. Nothing here is fatal past the repository: a Cursor key that fails
   * leaves a live, installed app behind, and the record says so.
   */
  async function runSequence(existingRepository?: GitHubRepository): Promise<void> {
    await refreshCloudflareIfStale();
    running.value = true;
    steps.value = createInitialSteps();

    try {
      mergeOutcome(
        await runCreateApp(
          {
            identity: identity.value,
            owner: session.credentials.value.githubOwner,
            private: form.value.private,
            ...(existingRepository ? { existingRepository } : {}),
          },
          buildDependencies(),
        ),
      );
    } finally {
      running.value = false;
    }
  }

  /** Start a brand-new app from the form. */
  async function createApp(): Promise<void> {
    if (!canCreateApp.value) {
      return;
    }
    result.value = null;
    agent.value = null;
    originReady.value = false;
    wiredForBuild.value = false;
    // Written down before the first API call, so a run that dies in the middle leaves
    // the name and the brief in the list rather than only in this page's memory.
    await records?.begin(identity.value, { private: form.value.private });
    await runSequence();
  }

  /**
   * Load a stored app into the flow without touching the network.
   *
   * Everything the phases need was written down the first time — both GitHub ids, the
   * branch, the Worker's script tag — so continuing an app is a local operation until
   * the user asks for actual work.
   */
  function openRecord(stored: StoredAppRecord): void {
    const record = stored.record;
    records?.resume(stored);

    form.value = {
      label: record.label,
      slug: record.appId,
      // The name is settled: it is in the repository, the Worker, and haven-app.json.
      slugFollowsLabel: false,
      description: record.description,
      task: record.task,
      private: record.private,
      databaseId: databaseIdFromSlug(record.appId),
      databaseLabel: record.label,
      databaseIdFollowsSlug: false,
      databaseLabelFollowsLabel: false,
      permissions: [...DEFAULT_APP_DATABASE_PERMISSIONS],
    };

    const storedAgent = record.cursorAgentId
      ? { id: record.cursorAgentId, url: record.cursorAgentUrl, runId: record.cursorRunId }
      : null;
    result.value = {
      steps: [],
      repository: repositoryFromRecord(record),
      worker: workerFromRecord(record),
      agent: storedAgent,
      installedAppInstanceId: record.havenInstanceId || null,
      identityCommitted: record.identityCommitted,
      warnings: [],
      error: null,
    };
    agent.value = storedAgent;
    originReady.value = record.originReady;
    wiredForBuild.value = record.wiredForBuild;
    steps.value = createInitialSteps();
  }

  /**
   * Carry on with the app that is open, doing whatever it still needs.
   *
   * The record decides, not the user: it knows what exists, so "continue" can be one
   * button instead of a menu of phases the user would have to pick from correctly.
   */
  async function continueApp(): Promise<void> {
    const record = records?.active.value;
    if (!record || running.value) {
      return;
    }

    switch (nextAppAction(record)) {
      case "create":
        // The name was reserved in the list but nothing was built. Run the sequence on
        // the existing record rather than beginning a second one for the same app.
        await runSequence();
        return;
      case "commit":
        // The project exists and is still the plain template — usually because GitHub
        // had not finished copying it when the first attempt looked. Re-run from here
        // with that project handed in, so the sequence adopts it instead of tripping
        // over the name it took.
        await runSequence(repositoryFromRecord(record) ?? undefined);
        return;
      case "publish":
        await deployCloudflare();
        return;
      case "build":
        // With a trigger already in place a build is all that is missing; without one,
        // the Cloudflare phase has to wire it first. Both end at the live URL.
        if (wiredForBuild.value) {
          await buildNow();
        } else {
          await deployCloudflare();
        }
        return;
      case "install":
        await registerHaven();
        return;
      case "iterate":
        await launchCursor();
        return;
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
    canCreateApp,
    canCreateRepo,
    canDeploy,
    canLaunchCursor,
    canRegisterHaven,
    cloudflareError,
    cloudflareSteps,
    continueApp,
    createApp,
    createAppError,
    createGitHubProject,
    cursorError,
    cursorSteps,
    openRecord,
    githubSteps,
    deployCloudflare,
    form,
    formError,
    githubError,
    identity,
    identityValid,
    launchCursor,
    onDatabaseIdInput,
    onDatabaseLabelInput,
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
