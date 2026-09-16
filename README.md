# MindooDB App Builder

Creates a new MindooDB Haven application end to end: a GitHub repository from the
[starter template](https://github.com/klehmann/mindoodb-app-starter), a live Cloudflare
Workers deployment that redeploys itself on every push, an optional Cursor cloud agent
working on your brief, and the finished app registered in Haven.

It is itself an ordinary Haven app. Run the hosted one, or run this repository yourself
and point Haven at your own URL — the code is here so you can check what it does with
your tokens before you paste them.

## What happens to your tokens

Three credentials are involved: a GitHub token, a Cloudflare token, and optionally a
Cursor API key.

- They are stored in **one recipient-sealed document** in your own App Builder database.
  Sealed means encrypted for you personally, so a builder database shared with your team
  still keeps the tokens readable only by you. They sync to your other devices the way
  any MindooDB document does.
- The **GitHub token never leaves the browser tab.** GitHub's API allows cross-origin
  calls, so the page uses it directly.
- The **Cloudflare token and Cursor key travel to the local host process** for the calls
  a browser physically cannot make — neither API sends CORS headers. Each request carries
  the token it needs, the host uses it for that one call, and forgets it. There is no
  session, no cache, no token file. See `src/host/routes.ts`; it is short on purpose.
- **No credential is ever given to the coding agent.** Handing a cloud VM a token that
  can deploy would be convenient and is exactly what this avoids: the repository deploys
  itself through Cloudflare's own Git integration, which needs no token hand-off.

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

| Credential | Where to get it | Scope |
| --- | --- | --- |
| GitHub token | github.com → Settings → Developer settings | Create repositories (classic `repo`, or fine-grained Contents + Administration) |
| Cloudflare token | dash.cloudflare.com → profile → API tokens | **User** token — the Builds API rejects account tokens. Workers Scripts Edit, Workers Builds Configuration Edit |
| Cloudflare account ID | Workers & Pages overview | — |
| Cursor API key | cursor.com → dashboard | Optional. Without it the repository is created and deployed, just not worked on |

One manual step has no API: the **Cloudflare GitHub App** must be installed on your
account once (dashboard → any Worker → Settings → Builds → Connect). The builder says so
if it is missing.

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
