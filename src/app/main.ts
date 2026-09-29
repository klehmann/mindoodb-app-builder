import { isLaunchedByHaven, renderHavenAppLandingPage } from "mindoodb-app-sdk";

/**
 * A direct visit to the deployed address is the info page. There is no Haven to connect
 * to, so the page shows the listing from `haven-app.json` and a button that installs the
 * builder. Haven's launch URL carries `mindoodbAppLaunchId` and still mounts the builder.
 *
 * Local `vite dev` mounts the builder too, so working on it does not need a launch id.
 * Hosting stays `external`: the info page is this origin's own HTML, and the outbound
 * calls the builder makes are the browser's, not a hosted bundle's.
 */
if (import.meta.env.PROD && !isLaunchedByHaven()) {
  void renderHavenAppLandingPage();
} else {
  void Promise.all([import("vue"), import("@/app/App.vue"), import("@/i18n")]).then(
    ([{ createApp }, { default: App }, { i18n }]) => {
      createApp(App).use(i18n).mount("#app");
    },
  );
}
