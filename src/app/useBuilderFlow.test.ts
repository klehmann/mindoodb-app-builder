import { describe, expect, it } from "vitest";
import { ref } from "vue";

import { useBuilderFlow } from "@/app/useBuilderFlow";
import type { useBuilderSession } from "@/app/useBuilderSession";
import { EMPTY_CREDENTIALS } from "@/core/credentials";
import { t } from "@/i18n";

/**
 * `plannedRepositoryName` is the name the UI puts in front of the user, so it has its own
 * tests: `identity.slug` cannot be empty and every consumer renders a placeholder for the
 * empty case, which means a leaky fallback here shows up as copy naming a project the
 * user never asked for.
 *
 * Nothing below reaches the session — the name is derived from the form alone, and the
 * composable installs no watchers — so a bare stub is enough to build the flow.
 */
function flow() {
  return useBuilderFlow({} as unknown as ReturnType<typeof useBuilderSession>);
}

describe("plannedRepositoryName", () => {
  it("is empty until the user names something", () => {
    expect(flow().plannedRepositoryName.value).toBe("");
  });

  it("follows the name the user types", () => {
    const builder = flow();

    builder.onLabelInput("Team Notes");

    expect(builder.plannedRepositoryName.value).toBe("team-notes");
  });

  it("goes back to empty when the name is cleared again", () => {
    // Clearing the label leaves `slugifyAppName`'s fallback in the slug field, because
    // the slug is still following the label. An empty name field must still read as one.
    const builder = flow();

    builder.onLabelInput("Team Notes");
    builder.onLabelInput("");

    expect(builder.form.value.slug).toBe("mindoodb-app");
    expect(builder.plannedRepositoryName.value).toBe("");
  });

  it("keeps the label's name when the user empties the address field", () => {
    // The app is still created from the label here, so copy that names it is correct.
    const builder = flow();

    builder.onLabelInput("Team Notes");
    builder.onSlugInput("");

    expect(builder.plannedRepositoryName.value).toBe("team-notes");
  });

  it("keeps the fallback slug once a name that cannot be slugified is typed", () => {
    // The distinction is whether the user has named anything, not whether the name
    // survives slugifying: an emoji-only label really will create "mindoodb-app", so
    // naming it here is accurate rather than leaked.
    const builder = flow();

    builder.onLabelInput("🙂🙂");

    expect(builder.identity.value.slug).toBe("mindoodb-app");
    expect(builder.plannedRepositoryName.value).toBe("mindoodb-app");
  });

  it("uses an explicitly typed slug even without a label", () => {
    const builder = flow();

    builder.onSlugInput("team-notes");

    expect(builder.plannedRepositoryName.value).toBe("team-notes");
  });
});

/**
 * The message that sends a user to the setup page has to name it the way the page is
 * actually labelled.
 *
 * It said "open Setup" for a while after the footer link became "Connections and setup",
 * which is the kind of drift nobody notices in English and no translator can catch. The
 * name is interpolated from the link's own key now, so this asserts the two stay tied
 * together rather than asserting any particular wording.
 */
describe("createAppError", () => {
  function unconnected(status: { github: boolean; cloudflare: boolean }) {
    const session = {
      credentials: ref({ ...EMPTY_CREDENTIALS }),
      credentialsStatus: ref({ ...status, cursor: false }),
    } as unknown as ReturnType<typeof useBuilderSession>;
    const builder = useBuilderFlow(session);
    builder.onLabelInput("Team Notes");
    return builder;
  }

  it("names the setup page by its own link label when GitHub is missing", () => {
    const error = unconnected({ github: false, cloudflare: false }).createAppError.value;

    expect(error).toContain(t("app.footer.setupLink"));
  });

  it("names the setup page by its own link label when Cloudflare is missing", () => {
    const error = unconnected({ github: true, cloudflare: false }).createAppError.value;

    expect(error).toContain(t("app.footer.setupLink"));
  });
});
