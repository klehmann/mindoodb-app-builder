import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import type { useAppRecords } from "@/app/useAppRecords";
import { useBuilderFlow } from "@/app/useBuilderFlow";
import type { useBuilderSession } from "@/app/useBuilderSession";
import {
  applyFlowOutcome,
  appRecordFromIdentity,
  type BuilderAppRecord,
  type StoredAppRecord,
} from "@/core/appRecords";
import { EMPTY_CREDENTIALS } from "@/core/credentials";

/**
 * Continuing an app is one button, and this is the file that says the button is right.
 *
 * The flow decides which phase to run from the stored record alone, which is what lets
 * the list offer "continue" without the user knowing what a build trigger is. Getting
 * that wrong is expensive in a way tests are cheap: resuming at "create" for an app whose
 * repository exists collides with itself, and resuming at "build" without a trigger
 * starts nothing.
 *
 * The core phases are mocked, so what is under test is the routing and the local state —
 * not the phases, which have their own tests in `createAppFlow.test.ts`.
 */
vi.mock("@/core/createAppFlow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/createAppFlow")>();
  const empty = () => ({
    steps: [],
    repository: null,
    worker: null,
    agent: null,
    installedAppInstanceId: null,
    warnings: [],
    error: null,
  });
  return {
    ...actual,
    createApp: vi.fn(async () => empty()),
    deployToCloudflare: vi.fn(async () => empty()),
    deployNow: vi.fn(async () => empty()),
    registerInHaven: vi.fn(async () => empty()),
    launchCursorWork: vi.fn(async () => empty()),
    createGitHubProject: vi.fn(async () => empty()),
  };
});

const phases = await import("@/core/createAppFlow");

const repository = {
  id: 42,
  name: "team-notes",
  fullName: "octocat/team-notes",
  owner: "octocat",
  ownerId: 7,
  htmlUrl: "https://github.com/octocat/team-notes",
  defaultBranch: "main",
};

const worker = {
  url: "https://team-notes.acme.workers.dev",
  scriptTag: "tag-1",
  reused: false,
};

function fakeSession(
  status = { github: true, cloudflare: true, cursor: true },
) {
  return {
    credentials: ref({
      ...EMPTY_CREDENTIALS,
      githubToken: "ghp_token",
      githubOwner: "octocat",
      cloudflareToken: "cf_token",
      cloudflareAccountId: "acct-1",
      cursorToken: "crsr_key",
    }),
    credentialsStatus: ref(status),
    canProposeApps: ref(true),
    storeCredentials: vi.fn(),
    proposeApp: vi.fn(),
  } as unknown as ReturnType<typeof useBuilderSession>;
}

function fakeRecords(record: BuilderAppRecord | null) {
  return {
    active: ref(record),
    activeDocumentId: ref(record ? "app_1" : null),
    begin: vi.fn(),
    resume: vi.fn(),
    recordPhase: vi.fn(),
  } as unknown as ReturnType<typeof useAppRecords>;
}

function planned(): BuilderAppRecord {
  return appRecordFromIdentity(
    {
      label: "Team Notes",
      slug: "team-notes",
      description: "Shared notes",
      task: "Let people write notes",
    },
    { private: true },
  );
}

function stored(record: BuilderAppRecord): StoredAppRecord {
  return { documentId: "app_1", record };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openRecord", () => {
  it("fills the form and the flow state from the record, with no network call", () => {
    const record = applyFlowOutcome(applyFlowOutcome(planned(), { repository }), {
      worker,
      agent: { id: "bc-1", url: "https://cursor.com/agents/bc-1", runId: "run-1" },
      wiredForBuild: true,
      originReady: true,
    });
    const builder = useBuilderFlow(fakeSession(), undefined, fakeRecords(null));

    builder.openRecord(stored(record));

    expect(builder.form.value).toMatchObject({
      label: "Team Notes",
      slug: "team-notes",
      description: "Shared notes",
      task: "Let people write notes",
      // The name is settled once it is in the repository and the Worker, so it must not
      // start following the label again and rename anything.
      slugFollowsLabel: false,
    });
    expect(builder.result.value?.repository).toEqual(repository);
    expect(builder.result.value?.worker).toMatchObject({ url: worker.url, scriptTag: "tag-1" });
    expect(builder.agent.value).toMatchObject({ id: "bc-1", runId: "run-1" });
    expect(builder.originReady.value).toBe(true);
    for (const mock of Object.values(phases)) {
      if (typeof mock === "function" && "mock" in mock) {
        expect(mock).not.toHaveBeenCalled();
      }
    }
  });

  it("leaves an app that was only described as having nothing built", () => {
    const builder = useBuilderFlow(fakeSession(), undefined, fakeRecords(null));

    builder.openRecord(stored(planned()));

    expect(builder.result.value?.repository).toBeNull();
    expect(builder.result.value?.worker).toBeNull();
    expect(builder.originReady.value).toBe(false);
  });
});

describe("continueApp", () => {
  async function continueWith(record: BuilderAppRecord) {
    const builder = useBuilderFlow(fakeSession(), undefined, fakeRecords(record));
    builder.openRecord(stored(record));
    await builder.continueApp();
    return builder;
  }

  it("runs the whole sequence when nothing exists yet", async () => {
    await continueWith(planned());

    expect(phases.createApp).toHaveBeenCalledTimes(1);
    expect(phases.deployToCloudflare).not.toHaveBeenCalled();
  });

  it("does not begin a second record for an app already in the list", async () => {
    // `createApp` on the page writes a new record first. Resuming must not, or the same
    // app would appear twice and the second copy would have no history.
    const records = fakeRecords(planned());
    const builder = useBuilderFlow(fakeSession(), undefined, records);
    builder.openRecord(stored(planned()));

    await builder.continueApp();

    expect(records.begin).not.toHaveBeenCalled();
    expect(phases.createApp).toHaveBeenCalledTimes(1);
  });

  it("publishes an app whose repository exists", async () => {
    await continueWith(applyFlowOutcome(planned(), { repository }));

    expect(phases.deployToCloudflare).toHaveBeenCalledTimes(1);
    expect(phases.createApp).not.toHaveBeenCalled();
  });

  it("starts a build for a published app that has a trigger", async () => {
    await continueWith(
      applyFlowOutcome(applyFlowOutcome(planned(), { repository }), {
        worker,
        wiredForBuild: true,
      }),
    );

    expect(phases.deployNow).toHaveBeenCalledTimes(1);
    expect(phases.deployToCloudflare).not.toHaveBeenCalled();
  });

  it("wires publishing first when the app has a Worker but no trigger", async () => {
    // A build belongs to a trigger. Without one there is nothing to start, so the
    // Cloudflare phase has to run — `deployNow` would fail with "nothing to build from".
    await continueWith(
      applyFlowOutcome(applyFlowOutcome(planned(), { repository }), { worker }),
    );

    expect(phases.deployToCloudflare).toHaveBeenCalledTimes(1);
    expect(phases.deployNow).not.toHaveBeenCalled();
  });

  it("asks Haven to install an app that is live but not installed", async () => {
    await continueWith(
      applyFlowOutcome(applyFlowOutcome(planned(), { repository }), {
        worker,
        wiredForBuild: true,
        originReady: true,
      }),
    );

    expect(phases.registerInHaven).toHaveBeenCalledTimes(1);
    expect(phases.deployNow).not.toHaveBeenCalled();
  });

  it("hands a finished app back to the agent", async () => {
    await continueWith(
      applyFlowOutcome(applyFlowOutcome(planned(), { repository }), {
        worker,
        wiredForBuild: true,
        originReady: true,
        installedAppInstanceId: "inst-1",
      }),
    );

    expect(phases.launchCursorWork).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an app open", async () => {
    const builder = useBuilderFlow(fakeSession(), undefined, fakeRecords(null));

    await builder.continueApp();

    expect(phases.createApp).not.toHaveBeenCalled();
    expect(phases.deployToCloudflare).not.toHaveBeenCalled();
  });
});

describe("createApp", () => {
  it("writes the app down before the first API call", async () => {
    // The point of the record: a run that dies in the middle leaves the name and the
    // brief in the list rather than only in the page's memory.
    const records = fakeRecords(null);
    const builder = useBuilderFlow(fakeSession(), undefined, records);
    builder.onLabelInput("Team Notes");

    await builder.createApp();

    expect(records.begin).toHaveBeenCalledTimes(1);
    expect(records.begin).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "team-notes", label: "Team Notes" }),
      { private: true },
    );
    expect(phases.createApp).toHaveBeenCalledTimes(1);
  });

  it("refuses to start without a name", async () => {
    const records = fakeRecords(null);
    const builder = useBuilderFlow(fakeSession(), undefined, records);

    await builder.createApp();

    expect(builder.createAppError.value).toBe("The app needs a name.");
    expect(records.begin).not.toHaveBeenCalled();
    expect(phases.createApp).not.toHaveBeenCalled();
  });

  it("names the missing connection rather than failing mid-run", async () => {
    const builder = useBuilderFlow(
      fakeSession({ github: true, cloudflare: false, cursor: false }),
      undefined,
      fakeRecords(null),
    );
    builder.onLabelInput("Team Notes");

    await builder.createApp();

    expect(builder.createAppError.value).toMatch(/Cloudflare is not connected/);
    expect(phases.createApp).not.toHaveBeenCalled();
  });
});
