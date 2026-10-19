# Working with the App Builder

The App Builder creates a Haven app from a description: a GitHub repository from the starter template, a Cloudflare Workers deployment that redeploys on every push, optionally a Cursor coding agent that implements the brief, and the installation in Haven. It keeps a list of the apps built with it.

## What agents may and may not do

- You can read the list, follow builds and the coding agent, and prepare work.
- You never start outward-facing work. Creating a repository, publishing to Cloudflare and starting a Cursor run (which uses the user's Cursor plan) happen only when the user presses the button. `builder_new_app_prefill` and `builder_agent_follow_up_prefill` fill in the page and return the button's label in the user's language; tell the user to review and press it.
- Tokens and API keys are never visible to you. If `builder_get_context` reports an account as not connected, ask the user to connect it under "Connections and setup".

## Where ids come from

- `appId`: `builder_apps_list`. It is the repository name and the app id at the same time.
- `undoStepId`: returned by `builder_apps_forget`.

## Build a new app

1. `builder_get_context`: check `connections` (GitHub and Cloudflare are needed, Cursor is optional) and that no build is running.
2. Turn the user's request into a short `name`, a one-line `description` and a `brief`: what the app does, its data, its screens, in plain language. The brief is what the coding agent works from.
3. `builder_new_app_prefill` with these. If the user has already typed into the form, the call is refused; ask, then repeat with `replace` true.
4. Read `blockedBy` in the result. If it is set, tell the user what is missing; otherwise ask them to press the build button.
5. Follow the build with `builder_get_context` (`build.currentStep`, `build.steps`, `failed`).

## Copy an existing app

`builder_new_app_prefill` with `mode` copy and `sourceUrl` (a GitHub repository URL or the running app's URL). The builder looks the source up and fills in name and description; check `form.source` and `form.sourceError`. Give a new `name` and a `brief` saying what should change.

## Continue an app

`builder_apps_get` tells you the `stage` and `nextAction`. `builder_app_open` shows the app's page and returns the Continue button's label: the user presses it to publish, add the app to Haven or hand it to the AI again.

## Follow the coding agent

`builder_agent_status` returns the current run's status, its summary and branches or pull requests. When the run has finished, `builder_agent_follow_up_prefill` writes the next instruction into the agent's box; the user sends it.

## Remove apps from the list

`builder_apps_forget` only removes the list entry; the repository, the Worker and the Haven installation keep running. Say so. `builder_undo` puts the entries back while the App Builder stays open.
