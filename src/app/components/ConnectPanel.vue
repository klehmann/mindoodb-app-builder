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
import { computed, reactive, ref, watch } from "vue";

import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import type { CloudflareAccount } from "@/core/cloudflare";
import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";

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
}>();

const emit = defineEmits<{ save: [BuilderCredentials] }>();

const draft = reactive<BuilderCredentials>({ ...props.credentials });

watch(
  () => props.credentials,
  (next) => Object.assign(draft, next),
  { deep: true },
);

const canConnectGitHub = computed(() => props.config?.oauth.github === true);
const canConnectCloudflare = computed(() => props.config?.oauth.cloudflare === true);

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
  () => (props.configLoaded && !canConnectCloudflare.value) || cloudflareManual.value,
);

const cursorKeysUrl = "https://cursor.com/dashboard?tab=api-keys";

function save(): void {
  emit("save", { ...draft });
}
</script>

<template>
  <section class="panel">
    <header>
      <h2>Accounts</h2>
      <p class="muted">
        Stored in one document in your App Builder database, encrypted for you personally.
        Nobody else can read it, not even someone you share that database with.
      </p>
      <p v-if="!canStore" class="warn">
        The <code>appbuilder</code> database is not available, so the connections are kept
        for this session only. Install the builder from Haven's App Store or its "From
        URL" path to have them remembered.
      </p>
    </header>

    <!-- GitHub -->
    <div class="account">
      <div class="account-head">
        <h3>GitHub</h3>
        <span v-if="status.github" class="badge">connected</span>
      </div>

      <template v-if="canConnectGitHub">
        <p v-if="github.status.value === 'waiting'" class="hint">
          Open
          <a :href="github.verificationUri.value" target="_blank" rel="noreferrer noopener">
            {{ github.verificationUri.value }}
          </a>
          and enter this code:
        </p>
        <p v-if="github.status.value === 'waiting'" class="device-code">
          {{ github.userCode.value }}
        </p>
        <p v-else class="hint">
          Grants permission to create a repository and make the first commit, on the
          repositories you choose. Revoke it any time in GitHub's application settings.
        </p>
        <p v-if="github.error.value" class="warn">{{ github.error.value }}</p>
        <!--
          Authorizing is not installing, and only an installation carries repository
          permissions — but that, and the rest of the once-per-account grants, are the
          setup list's job directly below. Saying it twice makes one click look like two.
        -->
        <div class="row">
          <button type="button" :disabled="github.busy.value" @click="github.start()">
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
          <button type="button" class="ghost" @click="githubManual = !githubManual">
            {{ githubManual ? "Hide token" : "Use my own token" }}
          </button>
        </div>
      </template>
      <p v-else-if="configLoaded" class="hint">
        This builder has no GitHub application registered, so there is nothing to connect
        to — paste a token instead.
      </p>
      <p v-else class="hint">Checking what this builder can connect to…</p>

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
          />
          <p class="hint">
            Needs permission to create repositories: classic <code>repo</code>, or
            fine-grained with Contents and Administration write. Used only by this page —
            GitHub allows browser calls, so it never reaches the builder host.
          </p>
        </div>
      </template>

      <!-- Always shown: filled in automatically after connecting, but an organization is
           a choice only the user can make. -->
      <div class="field">
        <label for="github-owner">GitHub owner</label>
        <input
          id="github-owner"
          v-model="draft.githubOwner"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="your-user-or-org"
        />
        <p class="hint">Leave blank to create repositories under the token's own account.</p>
      </div>
    </div>

    <!-- Cloudflare -->
    <div class="account">
      <div class="account-head">
        <h3>Cloudflare</h3>
        <span v-if="status.cloudflare" class="badge">connected</span>
      </div>

      <template v-if="canConnectCloudflare">
        <p class="hint">
          Opens Cloudflare's own consent screen. It asks for the Workers permissions the
          builder needs and nothing else, and the access token is exchanged in this page
          wherever Cloudflare allows it.
        </p>
        <p v-if="cloudflare.error.value" class="warn">{{ cloudflare.error.value }}</p>
        <div class="row">
          <button type="button" :disabled="cloudflare.busy.value" @click="cloudflare.connect()">
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
          <button type="button" class="ghost" @click="cloudflareManual = !cloudflareManual">
            {{ cloudflareManual ? "Hide token" : "Use my own token" }}
          </button>
        </div>
      </template>
      <p v-else-if="configLoaded" class="hint">
        This builder has no Cloudflare OAuth client registered, so there is nothing to
        connect to — paste a token instead.
      </p>
      <p v-else class="hint">Checking what this builder can connect to…</p>

      <template v-if="cloudflareFieldsVisible">
        <div class="field">
          <label for="cf-token">Cloudflare token</label>
          <input
            id="cf-token"
            v-model="draft.cloudflareToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
          />
          <p class="hint">
            Must be a <strong>user</strong> token, not an account token — the Workers Builds
            API rejects account tokens. Needs Workers Scripts&nbsp;Edit and Workers Builds
            Configuration&nbsp;Edit.
          </p>
        </div>
      </template>

      <!-- A list once a token can produce one, a field until then. -->
      <div v-if="cloudflareAccounts.length > 1" class="field">
        <label for="cf-account-select">Account</label>
        <select id="cf-account-select" v-model="draft.cloudflareAccountId">
          <option v-for="account in cloudflareAccounts" :key="account.id" :value="account.id">
            {{ account.name }}
          </option>
        </select>
      </div>
      <p v-else-if="cloudflareAccounts.length === 1" class="hint">
        Account: {{ cloudflareAccounts[0].name }}
      </p>
      <div v-else class="field">
        <label for="cf-account">Cloudflare account ID</label>
        <input
          id="cf-account"
          v-model="draft.cloudflareAccountId"
          type="text"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="hint">Workers &amp; Pages overview, right-hand column.</p>
      </div>
    </div>

    <!-- Cursor: no connect flow exists, so this one is typed. -->
    <div class="account">
      <div class="account-head">
        <h3>Cursor</h3>
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
          <a :href="cursorKeysUrl" target="_blank" rel="noreferrer noopener">Cursor's dashboard</a>.
          Used to start a cloud agent on the new repository. Cursor's API cannot be called
          from a browser and has no consent flow, so this one key is sent to the builder
          host for that single call. It is never given to the agent itself.
        </p>
      </div>
    </div>

    <button type="button" :disabled="saving" @click="save">
      {{ saving ? "Saving…" : "Save accounts" }}
    </button>
  </section>
</template>

<style scoped>
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

/* The one thing the user has to read off the screen and type somewhere else. */
.device-code {
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
