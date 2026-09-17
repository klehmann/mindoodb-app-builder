import { describe, expect, it } from "vitest";

import {
  canContinue,
  canEnterStep,
  furthestOpenStep,
  resolveInitialStep,
  type WizardReadiness,
} from "@/app/wizard";

function ready(overrides: Partial<WizardReadiness> = {}): WizardReadiness {
  return {
    githubConnected: true,
    githubInstallation: "installed",
    cloudflareConnected: true,
    cloudflareGit: "connected",
    cursorReady: true,
    identityValid: true,
    hasRepository: true,
    hasLiveOrigin: true,
    ...overrides,
  };
}

describe("furthestOpenStep", () => {
  it("leaves every page open so install and grant-access can be skipped", () => {
    expect(furthestOpenStep(ready({ identityValid: false }))).toBe("cursor");
    expect(
      furthestOpenStep(
        ready({
          githubInstallation: "missing",
          cloudflareGit: "unconfirmed",
          cursorReady: false,
          hasRepository: false,
          hasLiveOrigin: false,
        }),
      ),
    ).toBe("cursor");
  });
});

describe("resolveInitialStep", () => {
  it("starts on the introduction the first time", () => {
    expect(resolveInitialStep({ seenWelcome: false, readiness: ready() })).toBe("welcome");
  });

  it("returns to the first page that still has work we can see", () => {
    expect(
      resolveInitialStep({
        seenWelcome: true,
        readiness: ready({ identityValid: false }),
      }),
    ).toBe("details");
    expect(
      resolveInitialStep({
        seenWelcome: true,
        readiness: ready({ hasRepository: false, hasLiveOrigin: false }),
      }),
    ).toBe("github");
    expect(
      resolveInitialStep({
        seenWelcome: true,
        readiness: ready({ hasLiveOrigin: false }),
      }),
    ).toBe("cloudflare");
    expect(resolveInitialStep({ seenWelcome: true, readiness: ready() })).toBe("cursor");
  });
});

describe("canContinue", () => {
  it("lets the introduction go on, and details only once a name exists", () => {
    expect(canContinue("welcome", ready({ identityValid: false }))).toBe(true);
    expect(canContinue("details", ready({ identityValid: false }))).toBe(false);
    expect(canContinue("details", ready())).toBe(true);
  });

  it("does not block GitHub or Cloudflare on an install we cannot see", () => {
    const unseen = ready({
      githubInstallation: "missing",
      cloudflareGit: "unconfirmed",
      hasRepository: false,
      hasLiveOrigin: false,
    });
    expect(canContinue("github", unseen)).toBe(true);
    expect(canContinue("cloudflare", unseen)).toBe(true);
    expect(canContinue("cursor", unseen)).toBe(false);
  });
});

describe("canEnterStep", () => {
  it("lets the user open any page, including ones whose grants we cannot see", () => {
    expect(canEnterStep("welcome", ready({ identityValid: false }))).toBe(true);
    expect(canEnterStep("github", ready({ identityValid: false }))).toBe(true);
    expect(canEnterStep("cloudflare", ready({ githubInstallation: "missing" }))).toBe(true);
    expect(canEnterStep("cursor", ready({ cursorReady: false }))).toBe(true);
  });
});
