/**
 * The builder is pasted into Haven as a URL, so its ports are part of its interface and
 * belong in one place that both the Vite config and the host read.
 *
 * - `BUILDER_DEFAULT_PORT` is the real thing: the host serves the built SPA, its own
 *   `haven-app.json`, and `/api/*` on one origin. This is the URL a user pastes.
 * - `BUILDER_DEV_PORT` is Vite in front of that host, proxying `/api` to it, so hot
 *   reload works while the app still sees a single origin.
 */
export const BUILDER_DEFAULT_PORT = 4400;
export const BUILDER_DEV_PORT = 4401;

/**
 * Origins the host accepts `/api/*` requests from. The host holds no credentials and
 * sets no cookies, so this is not a CSRF boundary — it is there to keep a random page
 * the user happens to visit from driving deploys against a loopback service.
 */
export function builderAllowedOrigins(extra?: string): string[] {
  const origins = [
    `http://127.0.0.1:${BUILDER_DEFAULT_PORT}`,
    `http://localhost:${BUILDER_DEFAULT_PORT}`,
    `http://127.0.0.1:${BUILDER_DEV_PORT}`,
    `http://localhost:${BUILDER_DEV_PORT}`,
  ];
  const trimmed = extra?.trim();
  if (trimmed) {
    origins.push(...trimmed.split(",").map((entry) => entry.trim()).filter(Boolean));
  }
  return origins;
}
