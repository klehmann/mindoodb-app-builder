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
import { useI18n } from "vue-i18n";

import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import type { CloudflareAccount } from "@/core/cloudflare";
import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";

export type ConnectAccountId = "github" | "cloudflare" | "cursor";

const { t } = useI18n();

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
const cloudflareCallbackUrl = ref("");

async function submitCloudflareCallbackUrl(): Promise<void> {
  await props.cloudflare.completeFromCallbackUrl(cloudflareCallbackUrl.value);
}
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
      <h2>{{ t("connect.title") }}</h2>
      <p class="muted">{{ t("connect.storageHint") }}</p>
      <p v-if="!canStore" class="warn">{{ t("connect.ephemeralWarning") }}</p>
    </header>

    <!-- GitHub -->
    <div v-if="showGitHub" class="account">
      <div v-if="showAccountNames || status.github" class="account-head">
        <h3 v-if="showAccountNames">GitHub</h3>
        <span v-if="status.github" class="badge">{{
          t("connect.badge.connected")
        }}</span>
      </div>

      <template v-if="canConnectGitHub">
        <p v-if="github.status.value === 'waiting'" class="hint">
          {{ t("connect.github.deviceOpen") }}
          <a
            :href="github.verificationUri.value"
            target="_blank"
            rel="noreferrer noopener"
          >
            {{ github.verificationUri.value }}
          </a>
          {{ t("connect.github.deviceEnterCode") }}
        </p>
        <div v-if="github.status.value === 'waiting'" class="device-code-row">
          <p class="device-code">{{ github.userCode.value }}</p>
          <button type="button" class="ghost" @click="copyDeviceCode">
            {{
              copiedDeviceCode
                ? t("connect.deviceCode.copied")
                : t("connect.deviceCode.copy")
            }}
          </button>
        </div>
        <p v-else class="hint">{{ t("connect.github.scopeHint") }}</p>
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
                ? t("connect.github.waiting")
                : status.github
                  ? t("connect.github.reconnect")
                  : t("connect.github.connect")
            }}
          </button>
          <button
            v-if="github.status.value === 'waiting'"
            type="button"
            class="ghost"
            @click="github.cancel()"
          >
            {{ t("connect.cancel") }}
          </button>
          <button
            type="button"
            class="ghost"
            @click="githubManual = !githubManual"
          >
            {{ githubManual ? t("connect.hideToken") : t("connect.useOwnToken") }}
          </button>
        </div>
      </template>
      <!--
        Nothing is said about *why* there is no connect button here. Whether this
        deployment has a GitHub application registered is our problem, not the user's,
        and the token field below already says what to do instead.
      -->
      <p v-else-if="!configLoaded" class="hint">
        {{ t("connect.checkingOptions") }}
      </p>

      <template v-if="githubFieldsVisible">
        <div class="field">
          <label for="github-token">{{ t("connect.github.tokenLabel") }}</label>
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
            {{ t("connect.github.identifying") }}
          </p>
          <p v-else-if="github.identifyError.value" class="warn">
            {{ github.identifyError.value }}
          </p>
          <p class="hint">
            <a :href="githubTokenUrl" target="_blank" rel="noreferrer noopener">{{
              t("connect.github.tokenLinkText")
            }}</a>
            {{ t("connect.github.tokenHintBeforeScope") }}
            <code>repo</code>{{ t("connect.github.tokenHintAfterScope") }}
            <strong>{{ t("connect.github.generateTokenButton") }}</strong
            >{{ t("connect.github.tokenHintAfterGenerate") }}
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
        <summary>{{ t("connect.github.orgSummary") }}</summary>
        <div class="field owner__field">
          <label for="github-owner">{{ t("connect.github.ownerLabel") }}</label>
          <input
            id="github-owner"
            v-model="draft.githubOwner"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('connect.github.ownerPlaceholder')"
          />
          <p class="hint">{{ t("connect.github.ownerHint") }}</p>
        </div>
      </details>
    </div>

    <!-- Cloudflare -->
    <div v-if="showCloudflare" class="account">
      <div v-if="showAccountNames || status.cloudflare" class="account-head">
        <h3 v-if="showAccountNames">Cloudflare</h3>
        <span v-if="status.cloudflare" class="badge">{{
          t("connect.badge.connected")
        }}</span>
      </div>

      <template v-if="canConnectCloudflare">
        <p class="hint">{{ t("connect.cloudflare.consentHint") }}</p>
        <p v-if="cloudflare.status.value === 'waiting'" class="hint">
          {{ t("connect.cloudflare.waitingHint") }}
        </p>
        <form
          v-if="cloudflare.status.value === 'waiting'"
          class="callback-url"
          @submit.prevent="submitCloudflareCallbackUrl"
        >
          <label for="cf-callback-url">{{ t("connect.cloudflare.callbackUrlLabel") }}</label>
          <div class="row">
            <input
              id="cf-callback-url"
              v-model="cloudflareCallbackUrl"
              type="url"
              autocomplete="off"
              :placeholder="t('connect.cloudflare.callbackUrlPlaceholder')"
            />
            <button type="submit">{{ t("connect.cloudflare.callbackUrlApply") }}</button>
          </div>
        </form>
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
                ? t("connect.cloudflare.waiting")
                : cloudflare.status.value === "exchanging"
                  ? t("connect.cloudflare.finishing")
                  : status.cloudflare
                    ? t("connect.cloudflare.reconnect")
                    : t("connect.cloudflare.connect")
            }}
          </button>
          <button
            v-if="cloudflare.busy.value"
            type="button"
            class="ghost"
            @click="cloudflare.cancel()"
          >
            {{ t("connect.cancel") }}
          </button>
          <button
            type="button"
            class="ghost"
            @click="cloudflareManual = !cloudflareManual"
          >
            {{
              cloudflareManual ? t("connect.hideToken") : t("connect.useOwnToken")
            }}
          </button>
        </div>
      </template>
      <p v-else-if="!configLoaded" class="hint">
        {{ t("connect.checkingOptions") }}
      </p>

      <template v-if="cloudflareFieldsVisible">
        <div class="field">
          <label for="cf-token">{{ t("connect.cloudflare.tokenLabel") }}</label>
          <input
            id="cf-token"
            v-model="draft.cloudflareToken"
            type="password"
            autocomplete="off"
            spellcheck="false"
            @blur="identifyCloudflareToken"
          />
          <p v-if="cloudflare.identifying.value" class="hint">
            {{ t("connect.cloudflare.identifying") }}
          </p>
          <p class="hint">
            <a
              :href="cloudflareTokenUrl"
              target="_blank"
              rel="noreferrer noopener"
              >{{ t("connect.cloudflare.tokenLinkText") }}</a
            >
            {{ t("connect.cloudflare.tokenHintPress") }}
            <strong>{{ t("connect.cloudflare.createTokenButton") }}</strong
            >{{ t("connect.cloudflare.tokenHintScroll") }}
            <strong>{{ t("connect.cloudflare.createCustomTokenButton") }}</strong
            >{{ t("connect.cloudflare.tokenHintPermissions") }}
          </p>
          <p class="hint">
            {{ t("connect.cloudflare.profileHintIntro") }}
            <strong>{{ t("connect.cloudflare.profileTokensPath") }}</strong
            >{{ t("connect.cloudflare.profileHintMid") }}
            <strong>{{ t("connect.cloudflare.manageAccountLabel") }}</strong>
            {{ t("connect.cloudflare.profileHintTail") }}
          </p>
        </div>
      </template>

      <!--
        The account comes from the token, so there is nothing to type here in the normal
        case: a choice when the token can act on several accounts, a name when there is
        one, and the raw id only when Cloudflare could not be asked.
      -->
      <div v-if="cloudflareAccounts.length > 1" class="field">
        <label for="cf-account-select">{{
          t("connect.cloudflare.accountLabel")
        }}</label>
        <select id="cf-account-select" v-model="draft.cloudflareAccountId">
          <option
            v-for="account in cloudflareAccounts"
            :key="account.id"
            :value="account.id"
          >
            {{ account.name }}
          </option>
        </select>
        <p class="hint">{{ t("connect.cloudflare.accountSelectHint") }}</p>
      </div>
      <p v-else-if="cloudflareAccounts.length === 1" class="hint">
        {{ t("connect.cloudflare.accountPrefix") }}
        <strong>{{ cloudflareAccounts[0].name }}</strong>
      </p>
      <template v-else>
        <p v-if="cloudflare.identifyError.value" class="warn">
          {{ cloudflare.identifyError.value }}
          {{ t("connect.cloudflare.accountIdFallbackIntro") }}
          <a :href="cloudflareDashboardUrl" target="_blank" rel="noreferrer noopener"
            >{{ t("connect.cloudflare.dashboardLinkText") }}</a
          >
          {{ t("connect.cloudflare.accountIdFallbackTail") }}
          <code>dash.cloudflare.com/</code>.
        </p>
        <div v-if="showAccountIdField" class="field">
          <label for="cf-account">{{
            t("connect.cloudflare.accountIdLabel")
          }}</label>
          <input
            id="cf-account"
            v-model="draft.cloudflareAccountId"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('connect.cloudflare.accountIdPlaceholder')"
          />
          <p v-if="!cloudflare.identifyError.value" class="hint">
            {{ t("connect.cloudflare.accountIdHint") }}
          </p>
        </div>
        <!--
          An id that is already stored needs no field — but it does need to be visible and
          replaceable, because switching Cloudflare account is exactly the kind of thing
          that brings someone back to this page.
        -->
        <details v-else class="owner">
          <summary>
            {{
              t("connect.cloudflare.accountSummary", {
                id: draft.cloudflareAccountId,
              })
            }}
          </summary>
          <div class="field owner__field">
            <label for="cf-account-manual">{{
              t("connect.cloudflare.accountIdLabel")
            }}</label>
            <input
              id="cf-account-manual"
              v-model="draft.cloudflareAccountId"
              type="text"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="hint">
              {{ t("connect.cloudflare.accountIdManualHint") }}
            </p>
          </div>
        </details>
      </template>
    </div>

    <!-- Cursor: no connect flow exists, so this one is typed. -->
    <div v-if="showCursor" class="account">
      <div class="account-head">
        <h3 v-if="showAccountNames">Cursor</h3>
        <span v-if="status.cursor" class="badge">{{
          t("connect.badge.connected")
        }}</span>
        <span v-else class="badge badge--soft">{{
          t("connect.badge.optional")
        }}</span>
      </div>
      <div class="field">
        <label for="cursor-token">{{ t("connect.cursor.keyLabel") }}</label>
        <input
          id="cursor-token"
          v-model="draft.cursorToken"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="crsr_…"
        />
        <p class="hint">
          {{ t("connect.cursor.keyHintIntro") }}
          <a :href="cursorKeysUrl" target="_blank" rel="noreferrer noopener"
            >{{ t("connect.cursor.dashboardLinkText") }}</a
          >{{ t("connect.cursor.keyHintTail") }}
        </p>
        <p class="hint">{{ t("connect.cursor.optionalHint") }}</p>
      </div>
    </div>

    <button type="button" :disabled="saving" @click="save">
      {{
        saving
          ? t("connect.save.saving")
          : showAccountNames
            ? t("connect.save.accounts")
            : t("connect.save.one")
      }}
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

.callback-url {
  display: grid;
  gap: 0.35rem;
}

.callback-url input {
  flex: 1;
  min-width: 12rem;
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
