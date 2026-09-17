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
  readCredentialsStatus,
  EMPTY_CREDENTIALS,
  type BuilderCredentials,
} from "@/core/credentials";

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
  const theme = ref<MindooDBAppHostTheme>({ mode: "light", preset: "mindoo" });
  const connecting = ref(false);
  const savingCredentials = ref(false);
  const error = ref<string | null>(null);

  let unsubscribeTheme: (() => void) | null = null;

  const connected = computed(() => session.value !== null);
  const userName = computed(() => launchContext.value?.user.username ?? "");
  const credentialsStatus = computed(() => readCredentialsStatus(credentials.value));
  const databaseInfo = computed(
    () => launchContext.value?.databases.find((entry) => entry.id === BUILDER_DATABASE_ID) ?? null,
  );
  /**
   * Without write access the builder can still create repositories and deploy, but it
   * cannot remember the credentials between launches, which the UI has to say out loud.
   */
  const canStoreCredentials = computed(
    () => databaseInfo.value?.capabilities.includes("create") === true,
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

      if (databaseInfo.value) {
        database.value = await nextSession.openDatabase(BUILDER_DATABASE_ID);
        const loaded = await loadCredentials(database.value);
        credentials.value = loaded.credentials;
        credentialsDocId.value = loaded.documentId;
      }
    } catch (connectError) {
      /*
       * Deliberately not `readErrorMessage`: the bridge's own wording names internals
       * ("Missing mindoodbAppLaunchId in the current URL"), which tells a user nothing
       * and reads as a crash. Every cause has the same fix from their side, so they get
       * that fix, and whoever is debugging gets the original in the console.
       */
      console.error("[app-builder] Could not connect to Haven:", connectError);
      error.value =
        "Could not connect to Haven. Open the App Builder from your Haven workspace " +
        "rather than directly in a browser tab, then reload this page.";
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
      error.value = readErrorMessage(saveError, "The credentials could not be stored.");
    } finally {
      savingCredentials.value = false;
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
        message: "The builder is not connected to Haven.",
      };
    }
    return await current.proposeApp({ url });
  }

  async function disconnect(): Promise<void> {
    unsubscribeTheme?.();
    unsubscribeTheme = null;
    const current = session.value;
    session.value = null;
    database.value = null;
    credentialsDocId.value = null;
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
    canStoreCredentials,
    connect,
    connected,
    connecting,
    credentials,
    credentialsStatus,
    database,
    databaseInfo,
    disconnect,
    error,
    launchContext,
    proposeApp,
    savingCredentials,
    storeCredentials,
    theme,
    userName,
  };
}
