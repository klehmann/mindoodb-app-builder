import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_FRAGMENT_PREFIX,
  CLOUDFLARE_PENDING_KEY,
  CLOUDFLARE_RELAY_KEY,
  parseCloudflareCallbackUrl,
  parseCloudflareFragment,
  publishCloudflareRelay,
  readCloudflarePending,
  readCloudflareRelay,
  writeCloudflarePending,
} from "./cloudflareConnectRelay";

describe("cloudflareConnectRelay", () => {
  it("round-trips the pending verifier in session storage", () => {
    const storage = window.sessionStorage;
    storage.clear();
    const flow = {
      verifier: "v",
      state: "s",
      redirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
    };
    writeCloudflarePending(storage, flow);
    expect(readCloudflarePending(storage)).toEqual(flow);
    expect(storage.getItem(CLOUDFLARE_PENDING_KEY)).toContain("verifier");
    writeCloudflarePending(storage, null);
    expect(readCloudflarePending(storage)).toBeNull();
  });

  it("reads the fragment the callback page lands on", () => {
    const payload = { type: "mindoodb-app-builder/cloudflare-oauth", code: "c1", state: "s" };
    const hash = `${CLOUDFLARE_FRAGMENT_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
    expect(parseCloudflareFragment(hash)).toEqual(payload);
    expect(parseCloudflareFragment("#other")).toBeNull();
  });

  it("publishes a one-shot relay that other tabs can read from the storage event", () => {
    const writes: Array<{ key: string; value: string | null }> = [];
    const storage = {
      setItem(key: string, value: string) {
        writes.push({ key, value });
      },
      removeItem(key: string) {
        writes.push({ key, value: null });
      },
    } as unknown as Storage;

    const payload = { type: "mindoodb-app-builder/cloudflare-oauth", code: "c1" };
    publishCloudflareRelay(storage, payload);

    expect(writes).toEqual([
      { key: CLOUDFLARE_RELAY_KEY, value: JSON.stringify(payload) },
      { key: CLOUDFLARE_RELAY_KEY, value: null },
    ]);
    expect(readCloudflareRelay(JSON.stringify(payload))).toEqual(payload);
  });

  it("reads code and state from the deployed callback address", () => {
    const redirect = "https://app-builder.mindoodb.com/oauth/cloudflare/callback";
    expect(
      parseCloudflareCallbackUrl(
        `${redirect}?code=cf-code&state=s1`,
        redirect,
      ),
    ).toEqual({
      code: "cf-code",
      state: "s1",
      error: "",
      errorDescription: "",
    });
  });

  it("refuses a look-alike host so a pasted tracker URL cannot spend the verifier", () => {
    expect(
      parseCloudflareCallbackUrl(
        "https://app-builder.mindoodb.com.evil.test/oauth/cloudflare/callback?code=x&state=s",
        "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
      ),
    ).toBeNull();
  });
});
