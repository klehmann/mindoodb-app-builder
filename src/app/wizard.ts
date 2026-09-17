/**
 * Five setup pages, in the order the work actually happens.
 *
 * Install and grant-access buttons live on the GitHub / Cloudflare / Cursor pages.
 * Those grants cannot be verified for Cloudflare or Cursor from this token, and a user
 * who already chose "All repositories" should not be blocked waiting for a detection we
 * cannot do. Continue and the step list stay open; the buttons are there for people who
 * still need them.
 */
import type { GitHubInstallationState } from "@/app/useGitHubConnect";
import type { CloudflareGitState } from "@/app/useSetupReadiness";
import { githubAppInstallUrl } from "@/core/github";

export const CLOUDFLARE_GITHUB_APP_SLUG = "cloudflare-workers-and-pages";
export const CURSOR_GITHUB_APP_SLUG = "cursor";

/** Kept for the grant links and the leftover checklist. Not a wizard gate. */
export type AccessPath = "easy" | "precise";

export type WizardStepId = "welcome" | "details" | "github" | "cloudflare" | "cursor";

export const WIZARD_STEP_IDS: WizardStepId[] = [
  "welcome",
  "details",
  "github",
  "cloudflare",
  "cursor",
];

export const WIZARD_STEP_LABELS: Record<WizardStepId, string> = {
  welcome: "Introduction",
  details: "App details",
  github: "GitHub",
  cloudflare: "Cloudflare",
  cursor: "Cursor",
};

export interface WizardReadiness {
  githubConnected: boolean;
  githubInstallation: GitHubInstallationState;
  cloudflareConnected: boolean;
  cloudflareGit: CloudflareGitState;
  cursorReady: boolean;
  /** Name + a valid repository slug. Needed to create or recognise the repo. */
  identityValid: boolean;
  hasRepository: boolean;
  hasLiveOrigin: boolean;
}

export function cloudflareGitHubInstallUrl(): string {
  return githubAppInstallUrl(CLOUDFLARE_GITHUB_APP_SLUG);
}

export function cursorGitHubInstallUrl(): string {
  return githubAppInstallUrl(CURSOR_GITHUB_APP_SLUG);
}

/** Where a user adds one repository to an already-installed app. */
export const GITHUB_INSTALLATIONS_URL = "https://github.com/settings/installations";

/**
 * Furthest page that is honest to open.
 *
 * Install and grant-access are never a gate — we cannot see Cloudflare's or Cursor's
 * selection, and a user who already granted All repositories would be stuck if we
 * pretended we could. After the name is valid every later page is reachable so they can
 * skip ahead. Without a name, only Introduction and App details are offered.
 */
export function furthestOpenStep(_readiness: WizardReadiness): WizardStepId {
  // Install, grant-access, and even "I already created this repo" are the user's to
  // skip. The step list stays fully open after the introduction.
  return "cursor";
}

/**
 * Where to land a returning user.
 *
 * First visit stays on the introduction. After that, skip the pitch and open the first
 * page that still has work this builder can see — not a grant we cannot verify.
 */
export function resolveInitialStep(input: {
  seenWelcome: boolean;
  readiness: WizardReadiness;
}): WizardStepId {
  if (!input.seenWelcome) {
    return "welcome";
  }
  if (!input.readiness.identityValid) {
    return "details";
  }
  if (!input.readiness.hasRepository) {
    return "github";
  }
  if (!input.readiness.hasLiveOrigin) {
    return "cloudflare";
  }
  return "cursor";
}

export function canEnterStep(_step: WizardStepId, _readiness: WizardReadiness): boolean {
  return true;
}

export function stepAfter(step: WizardStepId): WizardStepId | null {
  const index = WIZARD_STEP_IDS.indexOf(step);
  return index >= 0 && index < WIZARD_STEP_IDS.length - 1 ? WIZARD_STEP_IDS[index + 1]! : null;
}

export function stepBefore(step: WizardStepId): WizardStepId | null {
  const index = WIZARD_STEP_IDS.indexOf(step);
  return index > 0 ? WIZARD_STEP_IDS[index - 1]! : null;
}

/**
 * Continue is never blocked by a GitHub App install or a repository grant.
 *
 * Those are buttons on the page, not prerequisites we can see. App details still needs
 * a name so the later pages have something to create.
 */
export function canContinue(step: WizardStepId, readiness: WizardReadiness): boolean {
  const next = stepAfter(step);
  if (!next) {
    return false;
  }
  if (step === "welcome") {
    return true;
  }
  if (step === "details") {
    return readiness.identityValid;
  }
  return true;
}
