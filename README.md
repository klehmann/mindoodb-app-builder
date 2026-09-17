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

### One-time setup

Some grants cannot be made through an API, because they are consent and every provider
insists on collecting it in its own interface. The builder shows the whole set as a
checklist between connecting and building — including the parts already satisfied, so
"ready" is distinguishable from "not checked yet" — and each is needed once per account
rather than once per app:

1. **Connect GitHub** and **connect Cloudflare**, with the buttons above the list.
2. **Install the builder's GitHub App.** Authorizing it and installing it are separate;
   only the installation carries repository permissions. Any repository selection works,
   including none, because GitHub grants access to repositories an app creates itself.
3. **Connect Cloudflare to GitHub, on "All repositories"** — dashboard → any Worker →
   Settings → Builds → Connect. Cloudflare documents this as a prerequisite for its
   Builds API, so it is the single step of a deploy with no programmatic route, and the
   repository scope is not optional for the reason below.
4. **Paste a Cursor API key**, if you want an agent to work on the app. Cursor has no
   consent flow at all.

Each item carries its own link to the page where the grant is made and a "Check again"
button, and the header counts what is outstanding. Only items that would certainly break
a build count: a Cursor key is marked optional, and a check that could not be answered is
marked as such rather than as a fault. While the count is above zero, **Create app is
disabled** — the same reasoning drives the list and the button, so the builder cannot
offer a build it already knows will fail.

#### What can and cannot be checked

Only two of these are observable, and knowing which is which is the difference between a
useful list and a list that lies.

The **builder's own GitHub App** is a real lookup: `GET /user/installations` answers for
the app the token belongs to, so its installation either appears or does not.

The **Cloudflare connection** is only inferable. No endpoint lists Git connections
(`PUT /builds/repos/connections` and its `DELETE` are the whole surface), so the builder
looks for an existing build trigger, which cannot exist without a connection. An account
that has built from a repository before reads as connected; one that has not reads as
"not confirmed", which is why that item is worded as a question and never blocks a build.

**Cloudflare's repository selection cannot be read from GitHub at all.** GitHub scopes
`GET /user/installations` to the app the token belongs to — "Lists installations of *your*
GitHub App" — so this builder's token sees exactly one installation, its own, however
many other apps the account has. Cloudflare's app is not missing from that response; it
is unaddressable. The builder used to check it anyway and read the silence as "not
installed", which told every user to install something most of them had already
installed, and refused their builds on the way.

**Cloudflare can be asked instead, and is.** `GET /builds/repos/github/{owner_id}/{repo_id}/config_autofill`
is what the dashboard calls when a repository is picked: Cloudflare reads the repository
to guess build settings, so a success proves access end to end, through whatever
installation the account really has. That also makes it a better question than the one
above — someone who keeps a hand-picked list and adds each repository to it passes, where
an "is it set to all repositories" check would wrongly fail them. It can only answer for a
repository that exists, so it runs as `check-repo-access`, immediately after
`create-repo`.

A refusal there does not stop the build, which is deliberate. The repository exists by
then, so aborting would take its name with it and the retry after granting access would
fail the name check — leaving the user renaming an app they had already created. Instead
the Worker, the connection and the identity commit all go ahead, so the app is wired and
only unbuilt. Only the two things that provably cannot work are skipped: waiting for a
build that was never triggered, and offering Haven a URL that is not serving yet.

**Build now** is how that app gets finished. Cloudflare builds on push, and by this point
there is no push left to make — the identity commit is already in the repository — so
asking the user to invent a commit would be asking them to work around us. The button
runs `deployNow`: it re-checks access (a refusal is fatal *here*, since nothing is
created and a build Cloudflare cannot clone would only replace a clear answer with a
failed build log), starts a build through the Worker's production trigger
(`POST /builds/triggers/{uuid}/builds` with the branch), then rejoins the original
sequence at the origin wait and the Haven install. Picking the production trigger
matters: an account with a hand-made preview trigger would otherwise build with
`wrangler versions upload`, which uploads a version without publishing it and leaves the
app just as unreachable.

The button appears whenever `connect-builds` succeeded and `wait-origin` did not — so it
also covers the origin timeout, not just a refused access check.

Cloudflare documents only 200 and 401 for that endpoint, so the mapping is cautious. A
refusal naming the repository (403/404) is a refusal; Cloudflare's routing codes 7000 and
7003 — "no route for that URI" — stay `unknown`, because that is what a moved endpoint
looks like and reading it as "no access" would invent a problem in every build.

New repositories are **private by default**, so an unfinished app's brief in `TASK.md`
is not public while you work on it.

Whatever you choose, **Cloudflare's GitHub App has to be set to "All repositories"** —
not for privacy reasons, but because a repository that does not exist yet cannot be in a
hand-picked list, and GitHub grants automatic access only to repositories an app creates
itself. With a selected-repositories installation the failure is silent rather than
loud: `PUT /builds/repos/connections` accepts the connection from ids alone, Cloudflare
never receives the push, no build runs, and the only symptoms are an origin that stays
quiet and a dashboard that later says "This project is disconnected from your Git
account". Nothing can verify it in advance (see above), so the builder states it in the
setup list and, when a build never appears, says so in the timeout: an empty Builds tab
means Cloudflare never saw the repository. The same applies to Cursor's GitHub access if
you want an agent to work on a private repository: Cloud Agents clone through
[Cursor's own GitHub App](https://github.com/apps/cursor/installations/new), never
this builder's token. The setup list has a button for that install; set it to
"All repositories" (or add the new repo after it exists), then start the agent
again.

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
- Repository permissions: Administration write, Contents write, Metadata read.
  Generating the repository from the template needs Administration **and** Contents
  together — GitHub counts creating a repository as administration — and a token without
  Administration fails with "Resource not accessible by integration", which names no
  permission at all.
- Changing permissions later is two steps: the app's settings, then accepting the
  request on the installation. Until it is accepted the installation keeps the old set,
  so the same 403 returns as if nothing had changed. Reconnect GitHub in the builder
  afterwards.
- **Install it as well as authorizing it.** These are separate acts, and the device flow
  only authorizes: a user token from an app that is not installed has no repository
  permissions at all, and every call fails with "Resource not accessible by
  integration". The builder checks right after connecting and offers the install link.
- **Only select repositories** is the right choice, and selecting none is fine — GitHub
  grants an installation access to the repositories the app itself creates. That keeps
  the token able to create repositories and write to its own, with no reach into
  anything you already have. This is also why the builder uses a GitHub App rather than
  an OAuth app: creating private repositories over OAuth needs the `repo` scope, which
  is read/write access to every private repository you own.
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
