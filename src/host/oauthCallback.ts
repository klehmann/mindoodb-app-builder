/**
 * The page Cloudflare redirects to after the user consents.
 *
 * It is deliberately almost nothing: read the authorization code out of the query
 * string, hand it to the window that started the flow, close. No token is ever minted
 * here, and nothing is stored.
 *
 * Its reason to exist is the relay. Cloudflare requires a pre-registered redirect URI
 * and offers no device grant, so a builder on `http://127.0.0.1:4400` cannot be the
 * redirect target — it registers nothing. Instead the deployed builder's callback is
 * registered once and passes the code back to whichever builder started the flow
 * (popup, same tab, or a new tab whose opener was stripped).
 *
 * Why that is safe: PKCE. The code verifier stays in the builder that generated it, so
 * a code seen in transit cannot be exchanged by the page that relayed it. The `state`
 * names the origin to hand the code to, and this page refuses any origin that is not
 * loopback or the configured public origin — so the code cannot be redirected to an
 * attacker's page by a crafted `state` either.
 *
 * The document is a fixed string. The only value interpolated into it is the builder's
 * own configured origin, and it is re-serialized through `URL` first so it cannot carry
 * anything but a scheme and a host.
 */
import type { BuilderOAuthConfig } from "../core/oauthConfig";

/** Message name the builder UI listens for. Changing it breaks the handshake. */
export const CLOUDFLARE_OAUTH_MESSAGE = "mindoodb-app-builder/cloudflare-oauth";

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function renderCloudflareCallbackPage(config: BuilderOAuthConfig): string {
  const publicOrigin = JSON.stringify(safeOrigin(config.publicOrigin));
  const messageType = JSON.stringify(CLOUDFLARE_OAUTH_MESSAGE);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Connecting Cloudflare…</title>
<meta name="robots" content="noindex" />
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 30rem; padding: 0 1rem; }
  p { color: #44515f; }
</style>
</head>
<body>
<h1>Connecting Cloudflare…</h1>
<p id="status">You can close this window.</p>
<script>
(function () {
  var PUBLIC_ORIGIN = ${publicOrigin};
  var MESSAGE_TYPE = ${messageType};
  var status = document.getElementById("status");

  function allowed(origin) {
    if (origin === PUBLIC_ORIGIN) return true;
    try {
      var url = new URL(origin);
      return url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        url.pathname === "/";
    } catch (error) {
      return false;
    }
  }

  function decodeState(value) {
    try {
      var padded = value.replace(/-/g, "+").replace(/_/g, "/");
      var bytes = Uint8Array.from(atob(padded), function (character) {
        return character.charCodeAt(0);
      });
      var parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && typeof parsed.origin === "string" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  var params = new URLSearchParams(window.location.search);
  var state = decodeState(params.get("state") || "");

  if (!state || !allowed(state.origin)) {
    status.textContent =
      "This callback was not started by a builder on this machine, so nothing was sent.";
    return;
  }

  var message = {
    type: MESSAGE_TYPE,
    code: params.get("code") || "",
    state: params.get("state") || "",
    error: params.get("error") || "",
    errorDescription: params.get("error_description") || "",
  };

  if (window.opener) {
    window.opener.postMessage(message, state.origin);
    window.close();
    return;
  }

  // Same tab, or a new tab whose opener was stripped (Cursor Simple Browser,
  // some iframe popup policies). The origin in state was already allowlisted
  // above — including loopback, so a local builder gets the code even though
  // this page itself lives on the deployed origin. The fragment is not sent
  // to any server.
  window.location.replace(
    state.origin + "/#cloudflare-oauth=" + encodeURIComponent(JSON.stringify(message)),
  );
})();
</script>
</body>
</html>
`;
}
