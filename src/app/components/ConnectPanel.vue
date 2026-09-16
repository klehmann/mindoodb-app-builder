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
 * GitHub and Cloudflare are connected rather than pasted when this builder is registered
 * for them: a device code for GitHub, a consent screen for Cloudflare. Both grants are
 * narrower than the equivalent hand-made token and both are revocable in one place. The
 * paste fields stay for a builder that has no registration of its own, and for anyone
 * who would rather mint their own token — but they are folded away, because they are no
 * longer the way in.
 *
 * Cursor has no such flow. Its API keys are dashboard-only, so that one is still typed.
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
  config: BuilderHostConfig | null;
  github: UseGitHubConnectReturn;
  cloudflare: UseCloudflareConnectReturn;
  /** Accounts the connected Cloudflare token can act on. Empty until connected. */
  cloudflareAccounts: CloudflareAccount[];
}>();

const emit = defineEmits<{ save: [BuilderCredentials] }>();

const draft = reactive<BuilderCredentials>({ ...props.credentials });
const showManual = ref(false);

watch(
  () => props.credentials,
  (next) => Object.assign(draft, next),
  { deep: true },
);

const canConnectGitHub = computed(() => props.config?.oauth.github === true);
const canConnectCloudflare = computed(() => props.config?.oauth.cloudflare === true);
/** With neither registration there is nothing to fold away, so show the fields outright. */
const manualOnly = computed(() => !canConnectGitHub.value && !canConnectCloudflare.value);
const manualVisible = computed(() => manualOnly.value || showManual.value);

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
        </div>
      </template>
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
        </div>
      </template>

      <!-- The account is a choice, not something to look up, once a token can list them. -->
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
    </div>

    <!-- Cursor: no connect flow exists, so this one is typed. -->
    <div class="field">
      <label for="cursor-token">
        Cursor API key
        <span v-if="status.cursor" class="badge">connected</span>
        <span v-else class="badge badge--soft">optional</span>
      </label>
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

    <button v-if="!manualOnly" type="button" class="ghost" @click="showManual = !showManual">
      {{ manualVisible ? "Hide tokens" : "Use my own tokens instead" }}
    </button>

    <template v-if="manualVisible">
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
          Needs permission to create repositories. Used only by this page — GitHub allows
          browser calls, so it never reaches the builder host.
        </p>
      </div>

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

      <div class="field">
        <label for="cf-account">Cloudflare account ID</label>
        <input
          id="cf-account"
          v-model="draft.cloudflareAccountId"
          type="text"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </template>

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
