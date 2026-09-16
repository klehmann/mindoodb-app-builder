# MindooDB App Builder

Creates a new MindooDB Haven application end to end: a GitHub repository from the
[starter template](https://github.com/klehmann/mindoodb-app-starter), a live Cloudflare
Workers deployment that redeploys itself on every push, an optional Cursor cloud agent
working on your brief, and the finished app registered in Haven.

It is itself an ordinary Haven app. Run the hosted one, or run this repository yourself
and point Haven at your own URL — the code is here so you can check what it does with
your tokens before you paste them.

## Connecting your accounts

GitHub and Cloudflare are connected with a click; Cursor is not, because its API keys are
dashboard-only.

- **GitHub** uses the device flow: the builder shows an eight-character code, you type it
  at `github.com/login/device` and approve. The grant is a GitHub App user token — it can
  create a repository and make the first commit on the repositories you chose, nothing
  more, and you revoke it in one place.
- **Cloudflare** uses OAuth with PKCE: its own consent screen lists the Workers
  permissions the builder asks for, and you approve there rather than assembling a token
  by hand. The access token is exchanged inside the browser tab wherever Cloudflare's
  CORS rules allow it.
- After either one, the builder asks who you are and which accounts you have, so there is
  no account ID or owner name to look up.

Pasting your own tokens still works and is behind "Use my own tokens instead" — useful if
you run a builder that has no applications registered, or you would rather mint a token
scoped your way.

Both flows need to open a window — Cloudflare's consent screen, and GitHub's device page —
so `haven-app.json` asks for `allowPopups`. Haven denies popups to apps by default and
grants capabilities at install time only, so a builder installed before this was added
keeps the old answer: switch "Allow popups" on in the app's settings in Haven, or remove
and reinstall it. Removing an app does not delete its data.

## What happens to your tokens

Three credentials are involved: a GitHub token, a Cloudflare token, and optionally a
Cursor API key.

- They are stored in **one recipient-sealed document** in your own App Builder database.
  Sealed means encrypted for you personally, so a builder database shared with your team
  still keeps the tokens readable only by you. They sync to your other devices the way
  any MindooDB document does. A sealed document cannot use a fixed id, so the builder
  finds it by querying for its `type`; MindooDB only indexes a sealed document on a
  replica that can decrypt it, so that query cannot reach anyone else's.
- The tokens sit in a nested `secrets` field rather than at the top level, which keeps
  them out of MindooDB's summary buffer — the local query index that would otherwise
  hold a copy of every top-level value.
- The **GitHub token never leaves the browser tab.** GitHub's API allows cross-origin
  calls, so the page uses it directly. The two device-flow calls go through the host
  because `github.com/login/*` sends no CORS headers, but they carry no credential *in* —
  only a public client id and the device code.
- The **Cloudflare token and Cursor key travel to the host process** for the calls a
  browser physically cannot make — neither API sends CORS headers. Each request carries
  the token it needs, the host uses it for that one call, and forgets it. There is no
  session, no cache, no token file. See `src/host/routes.ts`; it is short on purpose.
- **No credential is ever given to the coding agent.** Handing a cloud VM a token that
  can deploy would be convenient and is exactly what this avoids: the repository deploys
  itself through Cloudflare's own Git integration, which needs no token hand-off.

On a builder you run yourself, "the host" is a process on your own machine. On a hosted
builder it is someone else's server, and the difference is worth knowing: GitHub is
called from the page either way, and Cloudflare's OAuth exchange is too when CORS allows
it, so **the Cursor key is the one credential a hosted builder has to see**. If that
matters to you, run the builder locally — it is the same application.

## Running it

```bash
pnpm install
pnpm run build
pnpm start
```

That serves the app and the API on `http://127.0.0.1:4400`. Add that URL in Haven under
Applications, and Haven reads `haven-app.json` from it to register the app. A loopback
address is a secure origin, so an HTTPS Haven can embed it.

For development, two processes:

```bash
pnpm run dev:host   # API on 4400
pnpm run dev        # UI on 4401, proxying /api to 4400
```

Use `dev:local` instead of `dev` to resolve `mindoodb-app-sdk` from the sibling checkout.

## What it needs from you

| Credential | How | Notes |
| --- | --- | --- |
| GitHub | Connect GitHub, or paste a token | A pasted token needs classic `repo`, or fine-grained Contents + Administration write |
| Cloudflare | Connect Cloudflare, or paste a token | A pasted token must be a **user** token — the Builds API rejects account tokens — with Workers Scripts Edit and Workers Builds Configuration Edit |
| Cursor API key | cursor.com → dashboard | Optional, and typed: Cursor has no consent flow. Without it the repository is created and deployed, just not worked on |

One manual step has no API: the **Cloudflare GitHub App** must be installed on your
account once (dashboard → any Worker → Settings → Builds → Connect). The builder says so
if it is missing. This is Cloudflare's own integration and is unrelated to connecting
your GitHub account above.

## Deploying your own

The builder runs either as a Node process (`pnpm start`) or as a Cloudflare Worker. Both
serve the same UI and the same `/api/*` surface — `src/worker/index.ts` and
`src/host/server.ts` are two ways to reach one `handleApiRequest`.

```bash
pnpm run deploy        # builds the UI, then wrangler deploy
```

For the connect buttons to appear, the deployment needs its own applications registered.
Both client ids are public — these flows exist for clients that cannot keep a secret —
so they live in `wrangler.jsonc` under `vars`, and locally in the environment.

**GitHub App** (github.com → Settings → Developer settings → GitHub Apps → New):

- Enable **Device flow**. It is off by default, and the builder cannot start without it.
- Repository permissions: Administration write (create repositories), Contents write
  (the identity commit), Metadata read.
- Turn **off** expiring user tokens, or the connection dies after eight hours: a public
  client cannot refresh without a secret.
- Copy the Client ID into `BUILDER_GITHUB_CLIENT_ID`, and the app's URL slug into
  `BUILDER_GITHUB_APP_SLUG`.

**Cloudflare OAuth client** (dash.cloudflare.com → Manage Account → OAuth clients):

- Grant type `authorization_code`, token endpoint auth method `none`, PKCE `S256`.
- Redirect URI: `https://<your-host>/oauth/cloudflare/callback`.
- Allowed CORS origins: `https://<your-host>`. Worth setting — with it the browser
  exchanges the code itself and the access token never reaches the server at all.
- Scopes: `account-settings.read` (list your accounts), `workers-scripts.write` (create
  and deploy the Worker), `workers-ci.write` (Workers CI is the API name of Workers
  Builds — the git connection behind push-to-deploy), and `offline_access` (without it
  the token response has no refresh token and the connection dies after an hour). Scope
  ids are Cloudflare API token permission names, not wrangler's `workers:write` style;
  the client's own page lists the ids next to the names, and
  `curl https://api.cloudflare.com/client/v4/oauth/scopes -H "Authorization: Bearer $TOKEN"`
  is the full list. Cloudflare grants only what the authorize request names, and the
  request must be a subset of the registration: a request with no scopes shows
  "0 total permissions" with Authorize disabled. Override with
  `BUILDER_CLOUDFLARE_SCOPES` (space-separated) when your registration differs.
- Grant types: `authorization_code` plus `refresh_token`, which is what makes
  `offline_access` available in the first place.
- Copy the client id into `BUILDER_CLOUDFLARE_CLIENT_ID` and set `BUILDER_PUBLIC_ORIGIN`
  to the origin holding that redirect URI.

A client is usable by anyone only after its domain is verified with a DNS record, which
is permanent; before that it works for members of the account that registered it.

A builder on `http://127.0.0.1:4400` cannot register a redirect URI of its own, so it
borrows the deployed one: the callback page relays the code back to the loopback origin
that started the flow. That is safe because of PKCE — the code verifier never leaves the
builder that generated it, so a code in transit cannot be spent by the relay. Leave
`BUILDER_PUBLIC_ORIGIN` pointing at a deployment whose callback is registered, and local
builders keep working.

## The build, step by step

1. Check the repository name is free — failing here costs nothing.
2. Create the repository from the starter template.
3. Create a placeholder Worker, so the public URL and Cloudflare's script tag exist.
4. Connect push-to-deploy, before the first push rather than after.
5. Commit the app's identity (name, `wrangler.jsonc`, `haven-app.json`) and your brief
   into `TASK.md`. This push is the first deployment.
6. Poll the new origin until it really serves `haven-app.json` — the same file Haven's
   install reads, so a pass is evidence rather than a guess.
7. Start the Cursor agent, if a key is connected. Never fatal.
8. Ask Haven to install the app. You approve in Haven's own dialog; declining is fine and
   the app stays deployed.

Every step reports its own reason when it fails, and anything already created is named so
you can continue or clean up by hand.

## Building the same app twice

Re-running the flow for an app that is already in Haven updates its description and its
code, not its access: Haven grants databases and permissions at install time only, so an
origin cannot widen its own grant by redeploying. If the agent added a database to
`haven-app.json` in the meantime, the install dialog names it and the builder repeats it
as a warning — you grant it in the app's settings, or by removing the app in Haven and
installing it again. Removing an app does not delete its data.

## Layout

```
src/core/     framework-free: GitHub, Cloudflare, Cursor, the flow, the sealed document
src/host/     the Node process: static files and /api/*, ~200 lines
src/worker/   the same /api/* as a Cloudflare Worker, for a deployed copy
src/app/      the Vue UI
```

`src/core/createAppFlow.ts` is the whole build as one sequence against injected
dependencies, so every path through it — including each failure — is covered by
`createAppFlow.test.ts` without touching the network.

```bash
pnpm test
```

## License

Apache-2.0.
