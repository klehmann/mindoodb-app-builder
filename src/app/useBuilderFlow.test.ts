import { describe, expect, it } from "vitest";

import { useBuilderFlow } from "@/app/useBuilderFlow";
import type { useBuilderSession } from "@/app/useBuilderSession";

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
