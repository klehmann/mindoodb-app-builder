<script setup lang="ts">
/**
 * Where the three accounts are connected.
 *
 * The text on this panel matters as much as the fields: a user is being asked to grant
 * access to their GitHub and Cloudflare accounts, and they deserve to know exactly where
 * that ends up. It ends up in one document in their own Haven database, encrypted for
 * them personally — and, for the one call a browser cannot make, in a single request to
 * the builder host, which stores nothing.
 *
 * Each account owns its own section, and each section is self-contained: it offers the
 * connect flow when this builder is registered for one, and its own token fields when it
 * is not. That matters because "not registered" is a real state — a fresh deployment has
 * no GitHub App and no OAuth client until someone creates them — and a section that
 * renders as a lone heading in that state tells the user nothing.
 *
 * Cursor is last and always typed: its API keys are dashboard-only, with no consent flow
 * to offer.
 */
import { computed, onUnmounted, reactive, ref, watch } from "vue";

import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import type { CloudflareAccount } from "@/core/cloudflare";
import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";

export type ConnectAccountId = "github" | "cloudflare" | "cursor";

const props = defineProps<{
  credentials: BuilderCredentials;
  status: CredentialsStatus;
  canStore: boolean;
  saving: boolean;
  /** Null while it is still being read, or if the host could not be reached. */
  config: BuilderHostConfig | null;
  /**
   * Whether the config request has finished. Separate from `config` being null, which
   * is also what an unreachable host looks like: until this is true the panel says
   * nothing about the connect flows rather than guessing that there are none.
   */
  configLoaded: boolean;
  github: UseGitHubConnectReturn;
  cloudflare: UseCloudflareConnectReturn;
  /** Accounts the connected Cloudflare token can act on. Empty until connected. */
  cloudflareAccounts: CloudflareAccount[];
  /** Which account sections to show. Defaults to all three. */
  accounts?: ConnectAccountId[];
  /** Hide the panel heading when a wizard page already has one. */
  showHeader?: boolean;
}>();

const visibleAccounts = computed(
  () => props.accounts ?? ["github", "cloudflare", "cursor"],
);
const showGitHub = computed(() => visibleAccounts.value.includes("github"));
const showCloudflare = computed(() =>
  visibleAccounts.value.includes("cloudflare"),
);
const showCursor = computed(() => visibleAccounts.value.includes("cursor"));
const showPanelHeader = computed(() => props.showHeader !== false);
/**
 * Embedded in a wizard task, this is not a card of its own: the task already says which
 * service this is, so a nested box with a repeated heading reads as two chores.
 */
const embedded = computed(() => props.showHeader === false);
const showAccountNames = computed(() => visibleAccounts.value.length > 1);

const emit = defineEmits<{ save: [BuilderCredentials] }>();

const draft = reactive<BuilderCredentials>({ ...props.credentials });

watch(
  () => props.credentials,
  (next) => Object.assign(draft, next),
  { deep: true },
);

const canConnectGitHub = computed(() => props.config?.oauth.github === true);
const canConnectCloudflare = computed(
  () => props.config?.oauth.cloudflare === true,
);

/**
 * Whether to show the token fields. Forced open when there is no connect flow to offer,
 * because then they are the only way in rather than an alternative to one.
 */
const githubManual = ref(false);
const cloudflareManual = ref(false);
const githubFieldsVisible = computed(
  () => (props.configLoaded && !canConnectGitHub.value) || githubManual.value,
);
const cloudflareFieldsVisible = computed(
  () =>
    (props.configLoaded && !canConnectCloudflare.value) ||
    cloudflareManual.value,
);

/*
 * Deep links to where each token is actually created. Pasting a token is the fallback
 * path, so it is the one where a user is most likely to be stuck — "needs scope X" is no
 * help to someone who has never opened GitHub's developer settings.
 *
 * GitHub's new-token form reads `scopes` and `description` from the query string, so the
 * one permission we need arrives already ticked. Cloudflare has no such prefill, hence
 * the written-out permission names for that one.
 */
const githubTokenUrl =
  "https://github.com/settings/tokens/new?scopes=repo&description=MindooDB%20App%20Builder";
const cloudflareTokenUrl = "https://dash.cloudflare.com/profile/api-tokens";
/**
 * Where the account id can be read off by hand. Deliberately the bare dashboard: it
 * redirects to `/<account-id>/…`, so the id is in the address bar — which survives
 * Cloudflare moving the "Account ID" box around the page, as it has before.
 */
const cloudflareDashboardUrl = "https://dash.cloudflare.com/";
const cursorKeysUrl = "https://cursor.com/dashboard?tab=api-keys";

/**
 * Name the token's account as soon as it is pasted, rather than after Save.
 *
 * This is the earliest point anything can confirm the token works — every other GitHub
 * call happens after the user has committed to creating a project — so the login
 * appearing in the owner field doubles as "this token is good".
 *
 * Only ever fills a blank owner: an organization the user typed is their decision, not
 * something a lookup should overwrite.
 */
async function identifyGitHubToken(): Promise<void> {
  if (!draft.githubToken.trim() || draft.githubOwner.trim()) {
    return;
  }
  const login = await props.github.identifyToken(draft.githubToken);
  if (login) {
    draft.githubOwner = login;
  }
}

/**
 * Read the account id out of the pasted Cloudflare token, the same way the owner is read
 * out of the GitHub one.
 *
 * Unlike the GitHub owner this overwrites what is there, on purpose: the id belongs to
 * the token, so a stale id from a previous token is wrong rather than a preference. With
 * several accounts the first is pre-selected and the select below lets the user change
 * it; with none the lookup failed, and the id field appears so the run is not blocked.
 */
async function identifyCloudflareToken(): Promise<void> {
  const found = await props.cloudflare.identifyToken(draft.cloudflareToken);
  if (found.length === 0) {
    return;
  }
  const known = found.some((account) => account.id === draft.cloudflareAccountId);
  if (!known) {
    draft.cloudflareAccountId = found[0].id;
  }
}

/**
 * The id field is a fallback, not a step: it shows up when nothing else can supply the
 * id — no token pasted yet, or a token that could not be asked.
 */
const showAccountIdField = computed(
  () =>
    Boolean(props.cloudflare.identifyError.value)
    || (props.cloudflareAccounts.length === 0 && draft.cloudflareAccountId.trim() === ""),
);

function save(): void {
  emit("save", { ...draft });
}

/** Brief confirmation after a successful copy, then back to "Copy". */
const copiedDeviceCode = ref(false);
let copiedReset: ReturnType<typeof setTimeout> | undefined;

/**
 * The device code is the one thing on this page the user has to type somewhere else,
 * so it gets its own copy control. Clipboard access can fail in a framed tab; the
 * fallback still selects the code so a right-click or Cmd+C works.
 */
async function copyDeviceCode(): Promise<void> {
  const code = props.github.userCode.value;
  if (!code) {
    return;
  }
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    // Permission denied or no Clipboard API — leave the code selected instead.
    return;
  }
  copiedDeviceCode.value = true;
  if (copiedReset) {
    clearTimeout(copiedReset);
  }
  copiedReset = setTimeout(() => {
    copiedDeviceCode.value = false;
  }, 2000);
}

onUnmounted(() => {
  if (copiedReset) {
    clearTimeout(copiedReset);
  }
});
</script>

<template>
  <section class="panel" :class="{ 'panel--bare': embedded }">
    <header v-if="showPanelHeader">
      <h2>Accounts</h2>
      <p class="muted">
        Stored in one document in your App Builder database, encrypted for you
        personally. Nobody else can read it, not even someone you share that
        database with.
      </p>
      <p v-if="!canStore" class="warn">
        These connections will only last until you close this page. To have them
        remembered, install the App Builder from Haven's App Store — or add it
        by URL — instead of opening it directly.
      </p>
    </header>

    <!-- GitHub -->
    <div v-if="showGitHub" class="account">
      <div v-if="showAccountNames || status.github" class="account-head">
        <h3 v-if="showAccountNames">GitHub</h3>
        <span v-if="status.github" class="badge">connected</span>
      </div>

      <template v-if="canConnectGitHub">
        <p v-if="github.status.value === 'waiting'" class="hint">
          Open
          <a
            :href="github.verificationUri.value"
            target="_blank"
            rel="noreferrer noopener"
          >
            {{ github.verificationUri.value }}
          </a>
          and enter this code:
        </p>
        <div v-if="github.status.value === 'waiting'" class="device-code-row">
          <p class="device-code">{{ github.userCode.value }}</p>
          <button type="button" class="ghost" @click="copyDeviceCode">
            {{ copiedDeviceCode ? "Copied" : "Copy" }}
          </button>
        </div>
        <p v-else class="hint">
          Grants permission to create a new project and make the first commit —
          not to read the repositories you already have. Revoke it any time in
          GitHub's application settings.
        </p>
        <p v-if="github.error.value" class="warn">{{ github.error.value }}</p>
        <!--
          Authorizing is not installing, and only an installation carries repository
          permissions — but that, and the rest of the once-per-account grants, are the
          setup list's job directly below. Saying it twice makes one click look like two.
        -->
        <div class="row">
          <button
            type="button"
            :disabled="github.busy.value"
            @click="github.start()"
          >
            {{
              github.status.value === "waiting"
                ? "Waiting for GitHub…"
                : status.github
                  ? "Reconnect GitHub"
                  : "Connect GitHub"
            }}
          </button>
          <button
            v-if="github.status.value === 'waiting'"
            type="button"
            class="ghost"
            @click="github.cancel()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="ghost"
            @click="githubManual = !githubManual"
          >
            {{ githubManual ? "Hide token" : "Use my own token" }}
          </button>
        </div>
      </template>
      <!--
        Nothing is said about *why* there is no connect button here. Whether this
        deployment has a GitHub application registered is our problem, not the user's,
        and the token field below already says what to do instead.
      -->
      <p v-else-if="!configLoaded" class="hint">
        Checking how you can connect…
      </p>

      <template v-if="githubFieldsVisible">
        <div class="field">
          <label for="github-token">GitHub token</label>
          <input
            id="github-token"
            v-model="draft.githubToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="github_pat_…"
            @blur="identifyGitHubToken"
          />
          <p v-if="github.identifying.value" class="hint">
            Checking the token with GitHub…
          </p>
          <p v-else-if="github.identifyError.value" class="warn">
            {{ github.identifyError.value }}
          </p>
          <p class="hint">
            <a :href="githubTokenUrl" target="_blank" rel="noreferrer noopener"
              >Create a token on GitHub</a
            >
            — the link opens GitHub's form with the one permission we need,
            <code>repo</code>, already ticked. Check that it is, choose how long
            the token should last, press <strong>Generate token</strong>, then
            copy the value into the field above. GitHub shows it only once.
          </p>
        </div>
      </template>

      <!--
        Folded away, because for almost everyone it is not a decision: apps are created
        under the account the token belongs to, which is read from the token itself. It
        stays reachable because an organization is a choice only the user can make — and
        one that needs its own installs, which is why it is not the default.
      -->
      <details class="owner">
        <summary>Create apps under an organization instead</summary>
        <div class="field owner__field">
          <label for="github-owner">GitHub owner</label>
          <input
            id="github-owner"
            v-model="draft.githubOwner"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="your-user-or-org"
          />
          <p class="hint">
            Leave this alone and your apps are created under your own account. An
            organization works too, but the installs you approved for yourself do not
            cover it — you have to approve them there as well.
          </p>
        </div>
      </details>
    </div>

    <!-- Cloudflare -->
    <div v-if="showCloudflare" class="account">
      <div v-if="showAccountNames || status.cloudflare" class="account-head">
        <h3 v-if="showAccountNames">Cloudflare</h3>
        <span v-if="status.cloudflare" class="badge">connected</span>
      </div>

      <template v-if="canConnectCloudflare">
        <p class="hint">
          Opens Cloudflare's own consent screen. It asks for the Workers
          permissions the builder needs and nothing else, and the access token
          is exchanged in this page wherever Cloudflare allows it.
        </p>
        <p v-if="cloudflare.error.value" class="warn">
          {{ cloudflare.error.value }}
        </p>
        <div class="row">
          <button
            type="button"
            :disabled="cloudflare.busy.value"
            @click="cloudflare.connect()"
          >
            {{
              cloudflare.status.value === "waiting"
                ? "Waiting for Cloudflare…"
                : cloudflare.status.value === "exchanging"
                  ? "Finishing…"
                  : status.cloudflare
                    ? "Reconnect Cloudflare"
                    : "Connect Cloudflare"
            }}
          </button>
          <button
            v-if="cloudflare.busy.value"
            type="button"
            class="ghost"
            @click="cloudflare.cancel()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="ghost"
            @click="cloudflareManual = !cloudflareManual"
          >
            {{ cloudflareManual ? "Hide token" : "Use my own token" }}
          </button>
        </div>
      </template>
      <p v-else-if="!configLoaded" class="hint">
        Checking how you can connect…
      </p>

      <template v-if="cloudflareFieldsVisible">
        <div class="field">
          <label for="cf-token">Cloudflare token</label>
          <input
            id="cf-token"
            v-model="draft.cloudflareToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            @blur="identifyCloudflareToken"
          />
          <p v-if="cloudflare.identifying.value" class="hint">
            Checking the token with Cloudflare…
          </p>
          <p class="hint">
            <a
              :href="cloudflareTokenUrl"
              target="_blank"
              rel="noreferrer noopener"
              >Create a token on Cloudflare</a
            >
            — press <strong>Create Token</strong>, scroll down to
            <strong>Create Custom Token</strong>, and add these two permissions:
            Workers&nbsp;Scripts&nbsp;→&nbsp;Edit and Workers&nbsp;Builds
            Configuration&nbsp;→&nbsp;Edit. Then copy the token into the field
            above.
          </p>
          <p class="hint">
            Create it on the page that link opens —
            <strong>My Profile → API Tokens</strong>. Cloudflare offers tokens
            under <strong>Manage Account</strong> too, but those cannot switch
            on automatic publishing, so the next page would stop with an error.
          </p>
        </div>
      </template>

      <!--
        The account comes from the token, so there is nothing to type here in the normal
        case: a choice when the token can act on several accounts, a name when there is
        one, and the raw id only when Cloudflare could not be asked.
      -->
      <div v-if="cloudflareAccounts.length > 1" class="field">
        <label for="cf-account-select">Account</label>
        <select id="cf-account-select" v-model="draft.cloudflareAccountId">
          <option
            v-for="account in cloudflareAccounts"
            :key="account.id"
            :value="account.id"
          >
            {{ account.name }}
          </option>
        </select>
        <p class="hint">Your token can act on several — this is the one your apps go in.</p>
      </div>
      <p v-else-if="cloudflareAccounts.length === 1" class="hint">
        Account: <strong>{{ cloudflareAccounts[0].name }}</strong>
      </p>
      <template v-else>
        <p v-if="cloudflare.identifyError.value" class="warn">
          {{ cloudflare.identifyError.value }} You can enter it below instead: open
          <a :href="cloudflareDashboardUrl" target="_blank" rel="noreferrer noopener"
            >your Cloudflare dashboard</a
          >
          and copy the long code out of the address bar — the part right after
          <code>dash.cloudflare.com/</code>.
        </p>
        <div v-if="showAccountIdField" class="field">
          <label for="cf-account">Cloudflare account ID</label>
          <input
            id="cf-account"
            v-model="draft.cloudflareAccountId"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="read from your token"
          />
          <p v-if="!cloudflare.identifyError.value" class="hint">
            Normally there is nothing to fill in here — pasting the token above reads the
            account from it.
          </p>
        </div>
        <!--
          An id that is already stored needs no field — but it does need to be visible and
          replaceable, because switching Cloudflare account is exactly the kind of thing
          that brings someone back to this page.
        -->
        <details v-else class="owner">
          <summary>Account: {{ draft.cloudflareAccountId }}</summary>
          <div class="field owner__field">
            <label for="cf-account-manual">Cloudflare account ID</label>
            <input
              id="cf-account-manual"
              v-model="draft.cloudflareAccountId"
              type="text"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="hint">
              Pasting a token again reads this from the token. Change it by hand only if
              you know which account you want.
            </p>
          </div>
        </details>
      </template>
    </div>

    <!-- Cursor: no connect flow exists, so this one is typed. -->
    <div v-if="showCursor" class="account">
      <div class="account-head">
        <h3 v-if="showAccountNames">Cursor</h3>
        <span v-if="status.cursor" class="badge">connected</span>
        <span v-else class="badge badge--soft">optional</span>
      </div>
      <div class="field">
        <label for="cursor-token">API key</label>
        <input
          id="cursor-token"
          v-model="draft.cursorToken"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="crsr_…"
        />
        <p class="hint">
          Create one in
          <a :href="cursorKeysUrl" target="_blank" rel="noreferrer noopener"
            >Cursor's dashboard</a
          >. Used to start a cloud agent on the new repository. Cursor's API
          cannot be called from a browser and has no consent flow, so this one
          key is sent to the builder host for that single call. It is never
          given to the agent itself.
        </p>
        <p class="hint">
          Leave it empty if you would rather write the code yourself, or use another tool
          on the repository — Claude Code, Codex, your editor. Nothing else here depends
          on it.
        </p>
      </div>
    </div>

    <button type="button" :disabled="saving" @click="save">
      {{ saving ? "Saving…" : showAccountNames ? "Save accounts" : "Save" }}
    </button>
  </section>
</template>

<style scoped>
.owner summary {
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--app-muted);
}

.owner__field {
  padding-top: 0.6rem;
}

.panel--bare {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  gap: 0.6rem;
}

.account {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding-bottom: 0.2rem;
}

.account-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.account h3 {
  margin: 0;
  font-size: 0.92rem;
}

.row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

/*
 * A link that looks like the primary button next to it. It stays a real link so the new
 * tab opens without script — the iframe allows popups, but a plain anchor needs nothing.
 */
.button {
  font: inherit;
  padding: 0.45rem 0.9rem;
  border-radius: 0.35rem;
  background: var(--app-accent);
  color: #ffffff;
  text-decoration: none;
}

.device-code-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

/* The one thing the user has to read off the screen and type somewhere else. */
.device-code {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.5rem;
  letter-spacing: 0.15em;
  user-select: all;
}

select {
  font: inherit;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--app-border);
  border-radius: 0.35rem;
  background: var(--app-background);
  color: var(--app-text);
  align-self: flex-start;
}
</style>
