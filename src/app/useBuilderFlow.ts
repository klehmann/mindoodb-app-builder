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
  createApp as runCreateApp,
  createInitialSteps,
  type AgentHandle,
  type CreateAppDependencies,
  type CreateAppResult,
  type FlowStep,
} from "@/core/createAppFlow";
import {
  commitFiles,
  ensureRepositoryInInstallation,
  generateRepositoryFromTemplate,
  getFileText,
  getRepository,
  type GitHubRepository,
} from "@/core/github";
import { waitForOrigin } from "@/core/originProbe";
import {
  connectCloudflarePushToDeploy,
  ensureCloudflareWorker,
  launchCursorAgent,
  refreshCloudflareTokenViaHost,
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
    private: false,
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
    const status = session.credentialsStatus.value;
    if (!status.github) {
      return "Connect GitHub first.";
    }
    if (!status.cloudflare) {
      return "Connect Cloudflare first.";
    }
    return null;
  });

  const canStart = computed(() => formError.value === null && !running.value);

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

  function buildDependencies(): CreateAppDependencies {
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
        // A GitHub App installed on selected repositories does not cover one created a
        // second ago, and the identity commit would be refused. Only relevant when this
        // builder has an app at all; a pasted token has no installation.
        ...(hostConfig?.value?.githubAppSlug
          ? {
              ensureInstallationAccess: async (repository: GitHubRepository) => {
                await ensureRepositoryInInstallation({
                  token: githubToken,
                  appSlug: hostConfig.value?.githubAppSlug ?? "",
                  repositoryId: repository.id,
                });
              },
            }
          : {}),
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

  async function start(): Promise<void> {
    if (!canStart.value) {
      return;
    }
    await refreshCloudflareIfStale();
    running.value = true;
    steps.value = createInitialSteps();
    result.value = null;
    agent.value = null;

    try {
      const outcome = await runCreateApp(
        { identity: identity.value, owner: session.credentials.value.githubOwner },
        buildDependencies(),
      );
      result.value = outcome;
      agent.value = outcome.agent;
      steps.value = outcome.steps.map((step) => ({ ...step }));
    } finally {
      running.value = false;
    }
  }

  function reset(): void {
    form.value = createEmptyForm();
    steps.value = createInitialSteps();
    result.value = null;
    agent.value = null;
  }

  return {
    agent,
    canStart,
    form,
    formError,
    identity,
    onLabelInput,
    onSlugInput,
    plannedRepositoryName,
    reset,
    result,
    running,
    start,
    steps,
  };
}
