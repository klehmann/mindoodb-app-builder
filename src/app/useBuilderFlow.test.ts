import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("database fields", () => {
  it("follow the name until the user edits them", () => {
    const builder = flow();

    builder.onLabelInput("Team Notes");

    // The slug plus this form's own random part, so two "Team Notes" never share data.
    const suffix = builder.form.value.databaseSuffix;
    expect(suffix).toMatch(/^[a-z0-9]{6}$/);
    expect(builder.form.value.databaseId).toBe(`app_team-notes_${suffix}`);
    expect(builder.form.value.databaseLabel).toBe("Team Notes");
    expect(builder.identity.value.databasePermissions).toEqual([
      "write",
      "delete",
      "history",
      "attachments",
      "views",
      "directory",
    ]);
  });

  it("keeps an edited database id when the slug later changes", () => {
    const builder = flow();

    builder.onLabelInput("Team Notes");
    builder.onDatabaseIdInput("app_notes");
    builder.onSlugInput("other-name");

    expect(builder.form.value.databaseId).toBe("app_notes");
    expect(builder.form.value.databaseIdFollowsSlug).toBe(false);
  });

  it("keeps an edited database label when the app name later changes", () => {
    const builder = flow();

    builder.onLabelInput("Team Notes");
    builder.onDatabaseLabelInput("Shared notes");
    builder.onLabelInput("Other Name");

    expect(builder.form.value.databaseLabel).toBe("Shared notes");
    expect(builder.form.value.slug).toBe("other-name");
  });

  it("lowercases a typed database id", () => {
    const builder = flow();

    builder.onDatabaseIdInput("App_Notes");

    expect(builder.form.value.databaseId).toBe("app_notes");
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

describe("copy mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function copyFlow() {
    const session = {
      credentials: ref({ ...EMPTY_CREDENTIALS, githubToken: "ghu_test" }),
      credentialsStatus: ref({ github: true, cloudflare: true, cursor: false }),
    };
    const builder = useBuilderFlow(session as unknown as ReturnType<typeof useBuilderSession>);
    builder.reset("copy");
    return builder;
  }

  /** GitHub, answering for one public repository. */
  function stubGitHub() {
    const definition = {
      format: "mindoodb.haven.app",
      formatVersion: 1,
      appId: "team-poll",
      label: "Team Poll",
      description: "Polls for teams.",
      databases: [{ logicalDatabaseId: "main", permissions: ["write"] }],
    };
    const answers: Record<string, unknown> = {
      "/repos/acme/team-poll": {
        id: 1,
        name: "team-poll",
        full_name: "acme/team-poll",
        owner: { id: 2, login: "acme" },
        html_url: "https://github.com/acme/team-poll",
        default_branch: "main",
        private: false,
        description: "",
      },
      "/repos/acme/team-poll/commits/main": { sha: "abcdef1234567", commit: { tree: { sha: "tree1" } } },
      "/repos/acme/team-poll/git/trees/tree1": {
        truncated: false,
        tree: ["package.json", "wrangler.jsonc", "public/haven-app.json"].map((path) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: `sha-${path}`,
          size: 10,
        })),
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === "/repos/acme/team-poll/contents/public/haven-app.json") {
          return new Response(JSON.stringify(definition));
        }
        const body = answers[url.pathname];
        return body
          ? new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
          : new Response("{}", { status: 404 });
      }),
    );
  }

  it("cannot build until there is something to copy", () => {
    const builder = copyFlow();
    builder.onLabelInput("Our Poll");
    expect(builder.formError.value).toBe(t("flow.validation.sourceRequired"));
  });

  it("looks the source up and fills in the name and description from it", async () => {
    stubGitHub();
    const builder = copyFlow();
    builder.onSourceInput("https://github.com/acme/team-poll");

    await builder.loadSource();

    expect(builder.sourceError.value).toBeNull();
    expect(builder.form.value.source?.fullName).toBe("acme/team-poll");
    expect(builder.form.value.label).toBe("Team Poll");
    expect(builder.form.value.slug).toBe("team-poll");
    expect(builder.form.value.description).toBe("Polls for teams.");
    expect(builder.identity.value.copiedFrom).toMatchObject({
      fullName: "acme/team-poll",
      commitSha: "abcdef1234567",
      databases: [{ logicalDatabaseId: "main", label: "main" }],
    });
    expect(builder.formError.value).toBeNull();
  });

  it("keeps a name the user already typed", async () => {
    stubGitHub();
    const builder = copyFlow();
    builder.onLabelInput("Our Poll");
    builder.onSourceInput("acme/team-poll");

    await builder.loadSource();

    expect(builder.form.value.label).toBe("Our Poll");
  });

  it("says why a source cannot be used", async () => {
    stubGitHub();
    const builder = copyFlow();
    builder.onSourceInput("acme/missing");

    await builder.loadSource();

    expect(builder.form.value.source).toBeNull();
    expect(builder.sourceError.value).toEqual({
      code: "sourceRepoNotFound",
      params: { fullName: "acme/missing" },
    });
  });
});
