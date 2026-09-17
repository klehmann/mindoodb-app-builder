/**
 * The three GitHub App installations a built app depends on, and where to install them.
 *
 * None of these can be checked from the tokens the builder holds. GitHub tells an app
 * about its *own* installation and nothing about anyone else's, so whether Cloudflare can
 * read a repository, or whether Cursor was pointed at one, is invisible from here. That
 * is why the setup page asks the user to do them and then takes their word for it: a
 * check that cannot exist should not be pretended into the interface.
 *
 * Picking "All repositories" during these installs is what makes every later app a
 * single button — a repository created next month is already covered.
 */
import { githubAppInstallUrl } from "@/core/github";

export const CLOUDFLARE_GITHUB_APP_SLUG = "cloudflare-workers-and-pages";
export const CURSOR_GITHUB_APP_SLUG = "cursor";

/** Where Cloudflare's Workers and Pages app is installed or widened. */
export function cloudflareGitHubInstallUrl(): string {
  return githubAppInstallUrl(CLOUDFLARE_GITHUB_APP_SLUG);
}

/** Where Cursor's app is installed or widened. */
export function cursorGitHubInstallUrl(): string {
  return githubAppInstallUrl(CURSOR_GITHUB_APP_SLUG);
}

/** Where a user changes an existing installation, e.g. to add one repository to it. */
export const GITHUB_INSTALLATIONS_URL = "https://github.com/settings/installations";
