/**
 * "Can this build an app right now, and if not, what is missing?" — as data.
 *
 * Plain functions rather than component internals, because two places need the same
 * answer: the checklist the user reads, and the Create app button, which has no business
 * starting a build that the flow will refuse. Two copies of this reasoning would drift,
 * and the failure mode of drift here is a button that promises something it cannot do.
 *
 * Every grant described here is given in GitHub's or Cloudflare's own interface. None of
 * it can be granted through an API — that is what makes a checklist the right shape for
 * it, rather than a step the builder performs.
 */
import type { GitHubInstallationState } from "@/app/useGitHubConnect";
import type { CloudflareGitState } from "@/app/useSetupReadiness";
import type { CloudflareRepoAccess } from "@/core/github";

/**
 * `todo` is the only state that stops a build.
 *
 * `unsure` is a question that could not be answered — a pasted token may not be allowed
 * to ask — and blocking on one would punish people whose setup is already fine.
 * `optional` costs a feature rather than the app.
 */
export type SetupItemState = "done" | "todo" | "unsure" | "optional";

export interface SetupItem {
  key: string;
  title: string;
  state: SetupItemState;
  detail: string;
  /** Opens where the grant is actually made. */
  actionUrl?: string;
  actionLabel?: string;
  recheck?: "github" | "cloudflare" | "repoAccess";
}

export interface SetupInput {
  githubConnected: boolean;
  githubInstallation: GitHubInstallationState;
  githubInstallUrl: string;
  cloudflareConnected: boolean;
  cloudflareGit: CloudflareGitState;
  cloudflareDashboardUrl: string;
  cloudflareRepoAccess: CloudflareRepoAccess;
  cursorReady: boolean;
}

export function buildSetupItems(input: SetupInput): SetupItem[] {
  return [
    {
      key: "github-account",
      title: "GitHub account connected",
      state: input.githubConnected ? "done" : "todo",
      detail: input.githubConnected
        ? "Used to create the repository and make the first commit."
        : 'Use "Connect GitHub" above.',
    },
    githubAppItem(input),
    {
      key: "cloudflare-account",
      title: "Cloudflare account connected",
      state: input.cloudflareConnected ? "done" : "todo",
      detail: input.cloudflareConnected
        ? "Used to create the Worker and wire push-to-deploy."
        : 'Use "Connect Cloudflare" above.',
    },
    ...cloudflareGitHubItems(input),
    {
      key: "cursor",
      title: "Cursor API key",
      state: input.cursorReady ? "done" : "optional",
      detail: input.cursorReady
        ? "An agent will start working on the brief you write."
        : "Optional. Without it the app is still created and deployed, just not worked on. Cursor has no consent flow, so this one is pasted above.",
    },
  ];
}

export function countBlockers(items: SetupItem[]): number {
  return items.filter((item) => item.state === "todo").length;
}

/**
 * Authorizing and installing are separate acts, and only the installation carries
 * repository permissions. Getting this wrong produces GitHub's "Resource not accessible
 * by integration", which names neither the app nor the missing grant.
 */
function githubAppItem(input: SetupInput): SetupItem {
  if (input.githubInstallation === "installed") {
    return {
      key: "github-app",
      title: "Builder's GitHub App installed",
      state: "done",
      detail: "It can create repositories and write to the ones it creates.",
    };
  }
  if (input.githubInstallation === "missing") {
    return {
      key: "github-app",
      title: "Builder's GitHub App installed",
      state: "todo",
      detail:
        "Connecting proved who you are; installing is what allows a repository to be created. Any repository selection works, including none — GitHub grants access to repositories the app itself creates.",
      actionUrl: input.githubInstallUrl,
      actionLabel: "Install",
      recheck: "github",
    };
  }
  return {
    key: "github-app",
    title: "Builder's GitHub App installed",
    state: "unsure",
    detail:
      "Not checked yet. Connect GitHub to check, or ignore this if you pasted your own token — a personal access token has no installation.",
  };
}

/**
 * Cloudflare's side of the wiring, as one item or two.
 *
 * Two questions are being asked — is Cloudflare's GitHub app installed, and can it see
 * repositories that do not exist yet — but when the app is absent both have the same
 * answer and the same fix, and two entries demanding one click read as twice the work.
 * GitHub's installation listing settles it outright, so it wins over the weaker
 * build-trigger inference whenever it has an opinion.
 */
function cloudflareGitHubItems(input: SetupInput): SetupItem[] {
  if (input.cloudflareRepoAccess.state === "missing") {
    return [
      {
        key: "cloudflare-git",
        title: "Cloudflare connected to GitHub",
        state: "todo",
        detail:
          'Cloudflare\'s own GitHub app is not installed, so no push could reach Cloudflare. Install it on "All repositories" — from its dashboard under any Worker, Settings, Builds, Connect, or directly.',
        actionUrl: input.cloudflareRepoAccess.installUrl,
        actionLabel: "Install",
        recheck: "repoAccess",
      },
    ];
  }
  return [cloudflareGitItem(input), cloudflareRepoAccessItem(input)];
}

/**
 * Installing Cloudflare's GitHub App is the one step of a deploy with no API at all, so
 * this is detected from its footprint: an existing build trigger cannot exist without
 * it. Absence of evidence is reported as `unsure`, never as a fault.
 */
function cloudflareGitItem(input: SetupInput): SetupItem {
  if (input.cloudflareGit === "connected") {
    return {
      key: "cloudflare-git",
      title: "Cloudflare connected to GitHub",
      state: "done",
      detail: "This account has built from a repository before.",
    };
  }
  return {
    key: "cloudflare-git",
    title: "Cloudflare connected to GitHub",
    state: "unsure",
    detail:
      "Cloudflare's own GitHub app is installed from its dashboard: open any Worker, then Settings, Builds, Connect. If you have connected a repository on this account before, it is already done — nothing here can confirm it until the first build.",
    actionUrl: input.cloudflareDashboardUrl,
    actionLabel: "Open the dashboard",
    recheck: "cloudflare",
  };
}

/**
 * The one hard requirement nobody guesses, and the only check here that is a certainty
 * rather than an inference: a repository that does not exist yet cannot be in a
 * hand-picked list, and GitHub grants automatic access only to repositories an app
 * creates itself. Cloudflare accepts the connection anyway and then never builds.
 */
function cloudflareRepoAccessItem(input: SetupInput): SetupItem {
  const access = input.cloudflareRepoAccess;
  const title = "Cloudflare can read new repositories";

  if (access.state === "all") {
    return {
      key: "cloudflare-repo-access",
      title,
      state: "done",
      detail:
        'Its GitHub app is set to "All repositories", which includes the ones this builder creates.',
    };
  }
  if (access.state === "selected") {
    return {
      key: "cloudflare-repo-access",
      title,
      state: "todo",
      detail:
        'Its GitHub app is limited to selected repositories, so a new app would be connected but never built. Set it to "All repositories" — a repository that does not exist yet cannot be picked from a list.',
      actionUrl: access.settingsUrl,
      actionLabel: "Change repository access",
      recheck: "repoAccess",
    };
  }
  // `missing` never reaches here: it is folded into the connection item above.
  return {
    key: "cloudflare-repo-access",
    title,
    state: "unsure",
    detail: "Not checked yet. Connect GitHub to check.",
  };
}
