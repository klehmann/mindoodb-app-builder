import { describe, expect, it } from "vitest";

import { explainCursorLaunchError } from "./cursorAgents";

describe("explainCursorLaunchError", () => {
  it("leaves an unrelated failure alone", () => {
    expect(explainCursorLaunchError("Cursor rate limit reached", 429)).toBe(
      "Cursor rate limit reached",
    );
  });

  it("says which GitHub App is missing when Cursor cannot see the repository", () => {
    // The builder's token is never sent. A private repository it just created is
    // therefore invisible until Cursor's own installation can see it.
    const explained = explainCursorLaunchError("Cursor was not able to access the repo", 400);

    expect(explained).toContain("github.com/apps/cursor/installations/new");
    expect(explained).toContain("All repositories");
    expect(explained).toContain("Cursor was not able to access the repo");
  });
});
