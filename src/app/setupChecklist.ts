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
  recheck?: "github" | "cloudflare";
}

export interface SetupInput {
  githubConnected: boolean;
  githubInstallation: GitHubInstallationState;
  githubInstallUrl: string;
  cloudflareConnected: boolean;
  cloudflareGit: CloudflareGitState;
  cloudflareDashboardUrl: string;
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
    cloudflareGitItem(input),
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
 * Cloudflare's side of the wiring: install its GitHub App, and let it see repositories
 * that do not exist yet.
 *
 * Both halves are stated in one item because neither can be verified and both are fixed
 * in the same place. The connection itself is only inferable — no endpoint lists Git
 * connections, so `probeGitIntegration` looks for a build trigger, which cannot exist
 * without one — and the repository selection cannot be read at all: GitHub scopes
 * `GET /user/installations` to the app the token belongs to, so this builder's token is
 * blind to Cloudflare's installation however it asks.
 *
 * So this item never blocks a build. It carries the requirement that actually bites —
 * "All repositories", because GitHub grants automatic access only to repositories an app
 * creates itself, and Cloudflare accepts a connection for a repository it cannot see and
 * then never builds — and says plainly that it cannot confirm it.
 *
 * The confirmation happens during the build instead, where it is finally possible:
 * `check-repo-access` asks Cloudflare to read the new repository (`checkRepoReadable`)
 * seconds after creating it.
 */
function cloudflareGitItem(input: SetupInput): SetupItem {
  if (input.cloudflareGit === "connected") {
    return {
      key: "cloudflare-git",
      title: "Cloudflare connected to GitHub",
      state: "done",
      detail:
        'This account has built from a repository before. New repositories still need to be in reach of Cloudflare\'s GitHub app — "All repositories" covers them; a hand-picked list cannot.',
      actionUrl: input.cloudflareDashboardUrl,
      actionLabel: "Open the dashboard",
      recheck: "cloudflare",
    };
  }
  return {
    key: "cloudflare-git",
    title: "Cloudflare connected to GitHub",
    state: "unsure",
    detail:
      'Install Cloudflare\'s own GitHub app from its dashboard — any Worker, then Settings, Builds, Connect — and give it "All repositories". A repository that does not exist yet cannot be picked from a hand-picked list. Already done? Nothing here can confirm it, but the build will: right after creating the repository it asks Cloudflare to read it, and says so within seconds if it cannot. Fixing it then takes one click on Build now.',
    actionUrl: input.cloudflareDashboardUrl,
    actionLabel: "Open the dashboard",
    recheck: "cloudflare",
  };
}
