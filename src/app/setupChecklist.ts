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
import type { AccessPath } from "@/app/wizard";
import type { GitHubInstallationState } from "@/app/useGitHubConnect";
import type { CloudflareGitState } from "@/app/useSetupReadiness";
import {
  CLOUDFLARE_GITHUB_APP_SLUG,
  CURSOR_GITHUB_APP_SLUG,
  GITHUB_INSTALLATIONS_URL,
  cloudflareGitHubInstallUrl,
} from "@/app/wizard";
import { githubAppInstallUrl } from "@/core/github";

export { CURSOR_GITHUB_APP_SLUG, CLOUDFLARE_GITHUB_APP_SLUG };

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
  /** Easy = All repositories; precise = add each new repo to Cloudflare and Cursor. */
  accessPath?: AccessPath;
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
    cursorGitHubItem(input),
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
  const easy = input.accessPath !== "precise";
  if (input.githubInstallation === "installed") {
    return {
      key: "github-app",
      title: "MindooDB GitHub App installed",
      state: "done",
      detail: easy
        ? "Installed. On the easy path this one should also be set to All repositories."
        : "It can create repositories and write to the ones it creates — selected is enough.",
    };
  }
  if (input.githubInstallation === "missing") {
    return {
      key: "github-app",
      title: "MindooDB GitHub App installed",
      state: "todo",
      detail: easy
        ? 'Install it and choose "All repositories". That is the demo path: one grant, then a name and a brief.'
        : "Install it. Any repository selection works, including none — GitHub grants this app the repositories it creates.",
      actionUrl: input.githubInstallUrl,
      actionLabel: "Install MindooDB",
      recheck: "github",
    };
  }
  return {
    key: "github-app",
    title: "MindooDB GitHub App installed",
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
  const easy = input.accessPath !== "precise";
  const installUrl = cloudflareGitHubInstallUrl();
  if (input.cloudflareGit === "connected") {
    return {
      key: "cloudflare-git",
      title: "Cloudflare GitHub App installed",
      state: "done",
      detail: easy
        ? "This account has built from GitHub before. Keep that installation on All repositories so a brand-new app is visible."
        : "This account has built from GitHub before. After we create a repository, add it to this installation.",
      actionUrl: easy ? installUrl : GITHUB_INSTALLATIONS_URL,
      actionLabel: easy ? "Review access" : "Add a repository",
      recheck: "cloudflare",
    };
  }
  return {
    key: "cloudflare-git",
    title: "Cloudflare GitHub App installed",
    state: "unsure",
    detail: easy
      ? `Install Cloudflare Workers and Pages and choose "All repositories". We cannot see that installation from here — the first build will confirm it. The dashboard Connect step (${input.cloudflareDashboardUrl}) is the official first-time link if GitHub alone is not enough.`
      : `Install Cloudflare Workers and Pages. Selected repositories is fine — after we create the app, add that repo at ${GITHUB_INSTALLATIONS_URL}.`,
    actionUrl: installUrl,
    actionLabel: "Install Cloudflare",
    recheck: "cloudflare",
  };
}

/**
 * Cursor Cloud Agents clone through Cursor's GitHub App. This builder never hands
 * them a token — see `cursorAgents.ts` — so a private repository the builder just
 * created is invisible until that other installation can see it. Same shape as
 * Cloudflare's grant, and equally unobservable from this token.
 */
function cursorGitHubItem(input: SetupInput): SetupItem {
  const easy = input.accessPath !== "precise";
  const actionUrl = githubAppInstallUrl(CURSOR_GITHUB_APP_SLUG);
  if (!input.cursorReady) {
    return {
      key: "cursor-github",
      title: "Cursor GitHub App installed",
      state: "optional",
      detail: easy
        ? "Only needed if you connect a Cursor key. One click installs Cursor's GitHub App — choose All repositories for the demo path."
        : "Only needed if you connect a Cursor key. Install the app; after we create a private repository, add it to that installation.",
      actionUrl,
      actionLabel: "Install Cursor",
    };
  }
  return {
    key: "cursor-github",
    title: "Cursor GitHub App installed",
    state: "optional",
    detail: easy
      ? 'Cursor clones through its own GitHub App. Choose "All repositories" — we cannot see that installation. Start the agent again if it already failed.'
      : `Cursor clones through its own GitHub App. After we create the repository, add it at ${GITHUB_INSTALLATIONS_URL}.`,
    actionUrl: easy ? actionUrl : GITHUB_INSTALLATIONS_URL,
    actionLabel: easy ? "Install Cursor" : "Add a repository",
  };
}
