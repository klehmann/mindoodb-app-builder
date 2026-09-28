import { afterEach, describe, expect, it, vi } from "vitest";

import { appShareLink, buildAppShare, canShareApp, shareViaSheet } from "@/app/shareApp";
import { EMPTY_APP_RECORD, type BuilderAppRecord } from "@/core/appRecords";
import { t } from "@/i18n";

const live: BuilderAppRecord = {
  ...EMPTY_APP_RECORD,
  appId: "team-poll",
  label: "Team Poll",
  workerUrl: "https://team-poll.acme.workers.dev",
  originReady: true,
  repoUrl: "https://github.com/acme/team-poll",
  private: false,
};

describe("canShareApp", () => {
  it("shares only an app that is live on https", () => {
    expect(canShareApp(live)).toBe(true);
    expect(canShareApp({ ...live, originReady: false })).toBe(false);
    expect(canShareApp({ ...live, workerUrl: "" })).toBe(false);
    expect(canShareApp({ ...live, workerUrl: "http://127.0.0.1:4300" })).toBe(false);
  });
});

describe("appShareLink", () => {
  it("points the public Haven at the app's origin", () => {
    expect(appShareLink(live)).toBe(
      "https://haven.mindoodb.com/?app=https%3A%2F%2Fteam-poll.acme.workers.dev",
    );
  });
});

describe("buildAppShare", () => {
  it("says where the code is when the repository is public", () => {
    const share = buildAppShare(t, live, true);
    expect(share.title).toContain("Team Poll");
    expect(share.message).toContain(share.link);
    expect(share.message).toContain("https://team-poll.acme.workers.dev");
    expect(share.message).toContain("https://github.com/acme/team-poll");
  });

  it("leaves the code out when it is private", () => {
    expect(buildAppShare(t, live, false).message).not.toContain("github.com");
  });
});

describe("shareViaSheet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a missing share sheet, so the caller offers copying", async () => {
    vi.stubGlobal("navigator", {});
    await expect(shareViaSheet({ title: "t", message: "m" })).resolves.toBe("unsupported");
  });

  it("takes a closed sheet as an answer, not a failure", async () => {
    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("closed", "AbortError");
      }),
    });
    await expect(shareViaSheet({ title: "t", message: "m" })).resolves.toBe("cancelled");
  });

  it("passes title and text to the sheet", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    await expect(shareViaSheet({ title: "t", message: "m" })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "t", text: "m" });
  });
});
