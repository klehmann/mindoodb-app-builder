/**
 * The builder's own Haven session: connect, open the `appbuilder` database, and read or
 * write the sealed credential document.
 *
 * This is the only part of the builder that talks to Haven for its *own* sake. Telling
 * Haven about a newly built app is `proposeApp()` at the bottom of this file — one
 * origin, nothing else. Haven fetches that origin's `haven-app.json` itself and asks the
 * user, so the builder cannot describe one app and register another even if it wanted
 * to.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import {
  createMindooDBAppBridge,
  type MindooDBAppDatabase,
  type MindooDBAppHostTheme,
  type MindooDBAppLaunchContext,
  type MindooDBAppProposeAppResult,
  type MindooDBAppSession,
} from "mindoodb-app-sdk";

import {
  loadCredentials,
  saveCredentials,
  shareCredentials,
  readCredentialsStatus,
  EMPTY_CREDENTIALS,
  type BuilderCredentials,
} from "@/core/credentials";
import { setUiLanguage, t } from "@/i18n";

/** Logical id declared in the builder's `haven-app.json`. */
export const BUILDER_DATABASE_ID = "appbuilder";

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useBuilderSession() {
  const session = ref<MindooDBAppSession | null>(null);
  const launchContext = ref<MindooDBAppLaunchContext | null>(null);
  const database = ref<MindooDBAppDatabase | null>(null);
  const credentials = ref<BuilderCredentials>({ ...EMPTY_CREDENTIALS });
  /** Id of this user's sealed credential document — random, so it has to be remembered. */
  const credentialsDocId = ref<string | null>(null);
  /** Who else can read the credential document, besides this user. */
  const credentialsSharedWith = ref<string[]>([]);
  /** Directory usernames, for picking whom to share with. Empty until asked for. */
  const directoryUsers = ref<string[]>([]);
  const sharingCredentials = ref(false);
  const theme = ref<MindooDBAppHostTheme>({ mode: "light", preset: "mindoo" });
  const connecting = ref(false);
  const savingCredentials = ref(false);
  const error = ref<string | null>(null);

  let unsubscribeTheme: (() => void) | null = null;
  let unsubscribeLocale: (() => void) | null = null;

  const connected = computed(() => session.value !== null);
  const credentialsStatus = computed(() =>
    readCredentialsStatus(credentials.value),
  );
  const databaseInfo = computed(
    () =>
      launchContext.value?.databases.find(
        (entry) => entry.id === BUILDER_DATABASE_ID,
      ) ?? null,
  );
  /**
   * Without write access the builder can still create repositories and deploy, but it
   * cannot remember the credentials between launches, which the UI has to say out loud.
   */
  const canStoreCredentials = computed(
    () => databaseInfo.value?.capabilities.includes("create") === true,
  );
  /** The launching user, as MindooDB names readers of a sealed document. */
  const currentUser = computed(() => launchContext.value?.user.username ?? "");
  /**
   * Sharing needs a saved document to share, a way to change its readers, and the
   * directory to pick them from. An install from before `directory` was requested lacks
   * the last one, and the page says how to grant it rather than offering a dead list.
   */
  const canReadDirectory = computed(
    () => databaseInfo.value?.capabilities.includes("directory") === true,
  );
  /**
   * Registration-level permission, reported by the host in the launch context. When it
   * is missing the builder hides "add to Haven" and shows the app URL to paste
   * manually — the bridge would refuse the call anyway, and failing at the end of a
   * successful build is the worst possible moment to find out.
   */
  const canProposeApps = computed(
    () => launchContext.value?.appPermissions?.includes("proposeapps") === true,
  );

  function applyTheme(next: MindooDBAppHostTheme): void {
    theme.value = next;
    document.documentElement.dataset.theme = next.mode;
  }

  async function connect(): Promise<void> {
    connecting.value = true;
    error.value = null;
    try {
      const bridge = createMindooDBAppBridge();
      const nextSession = await bridge.connect();
      session.value = nextSession;

      const context = await nextSession.getLaunchContext();
      launchContext.value = context;
      applyTheme(context.theme);
      unsubscribeTheme = nextSession.onThemeChange(applyTheme);

      // The builder follows Haven's language the same way it follows its theme, and it
      // keeps following: switching the language in Haven re-renders this app rather than
      // leaving it in the language it happened to launch in.
      setUiLanguage(context.locale);
      unsubscribeLocale = nextSession.onLocaleChange(setUiLanguage);

      if (databaseInfo.value) {
        database.value = await nextSession.openDatabase(BUILDER_DATABASE_ID);
        const loaded = await loadCredentials(database.value, currentUser.value);
        credentials.value = loaded.credentials;
        credentialsDocId.value = loaded.documentId;
        credentialsSharedWith.value = loaded.sharedWith;
      }
    } catch (connectError) {
      /*
       * Deliberately not `readErrorMessage`: the bridge's own wording names internals
       * ("Missing mindoodbAppLaunchId in the current URL"), which tells a user nothing
       * and reads as a crash. Every cause has the same fix from their side, so they get
       * that fix, and whoever is debugging gets the original in the console.
       */
      console.error("[app-builder] Could not connect to Haven:", connectError);
      error.value = t("session.connectFailed");
    } finally {
      connecting.value = false;
    }
  }

  /**
   * Persist the credentials into the sealed document.
   *
   * Kept in memory either way: a user without write access to the builder database can
   * still complete a build this session, they just have to paste the tokens again next
   * time.
   */
  async function storeCredentials(next: BuilderCredentials): Promise<void> {
    credentials.value = next;
    if (!database.value || !canStoreCredentials.value) {
      return;
    }
    savingCredentials.value = true;
    error.value = null;
    try {
      credentialsDocId.value = await saveCredentials(
        database.value,
        next,
        credentialsDocId.value,
      );
    } catch (saveError) {
      error.value = readErrorMessage(saveError, t("session.credentialsStoreFailed"));
    } finally {
      savingCredentials.value = false;
    }
  }

  /** Read the directory's usernames for the sharing list. Empty when it cannot be read. */
  async function loadDirectoryUsers(): Promise<void> {
    if (!database.value || !canReadDirectory.value) {
      directoryUsers.value = [];
      return;
    }
    try {
      directoryUsers.value = await database.value.directory.listUsers();
    } catch {
      directoryUsers.value = [];
    }
  }

  /**
   * Make `next` the people who share this user's credentials. Saves the credentials
   * first when there is no document yet, because only a stored document has readers.
   */
  async function shareCredentialsWith(next: string[]): Promise<void> {
    if (!database.value || !canStoreCredentials.value) {
      return;
    }
    sharingCredentials.value = true;
    error.value = null;
    try {
      if (!credentialsDocId.value) {
        credentialsDocId.value = await saveCredentials(database.value, credentials.value, null);
      }
      credentialsSharedWith.value = await shareCredentials(
        database.value,
        credentialsDocId.value,
        credentialsSharedWith.value,
        next,
        currentUser.value,
      );
    } catch (shareError) {
      error.value = readErrorMessage(shareError, t("session.credentialsShareFailed"));
    } finally {
      sharingCredentials.value = false;
    }
  }

  /**
   * Ask Haven to install an app from its origin.
   *
   * A declined dialog comes back as `{ outcome: "declined" }` rather than as an
   * exception — the user saying no is a normal answer, not a failure.
   */
  async function proposeApp(url: string): Promise<MindooDBAppProposeAppResult> {
    const current = session.value;
    if (!current) {
      return {
        ok: false,
        reason: "unavailable",
        message: t("session.notConnected"),
      };
    }
    return await current.proposeApp({ url });
  }

  async function disconnect(): Promise<void> {
    unsubscribeTheme?.();
    unsubscribeTheme = null;
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    const current = session.value;
    session.value = null;
    database.value = null;
    credentialsDocId.value = null;
    credentialsSharedWith.value = [];
    if (!current) {
      return;
    }
    try {
      await current.disconnect();
    } catch {
      // Teardown is best-effort.
    }
  }

  onBeforeUnmount(() => {
    void disconnect();
  });

  return {
    canProposeApps,
    canReadDirectory,
    canStoreCredentials,
    connect,
    connected,
    connecting,
    credentials,
    credentialsSharedWith,
    credentialsStatus,
    currentUser,
    directoryUsers,
    database,
    databaseInfo,
    disconnect,
    error,
    launchContext,
    loadDirectoryUsers,
    proposeApp,
    savingCredentials,
    shareCredentialsWith,
    sharingCredentials,
    storeCredentials,
    theme,
  };
}
