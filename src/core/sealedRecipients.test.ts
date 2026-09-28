import { describe, expect, it } from "vitest";

import {
  activeRecipients,
  displayRecipient,
  otherRecipients,
  recipientDiff,
  recipientNamesEqual,
} from "@/core/sealedRecipients";

const data = {
  _encryptFor: {
    "cn=Ann/o=Acme#k1": { kind: "user", label: "cn=Ann/o=Acme" },
    "cn=Bob/o=Acme#k2": { kind: "user", label: "cn=Bob/o=Acme" },
    "cn=Eve/o=Acme#k3": { kind: "user", label: "cn=Eve/o=Acme", removedAt: 5 },
    "laptop#k4": { kind: "device" },
  },
};

describe("sealed recipients", () => {
  it("lists current readers only", () => {
    expect(activeRecipients(data)).toEqual(["cn=Ann/o=Acme", "cn=Bob/o=Acme"]);
    expect(activeRecipients({})).toEqual([]);
  });

  it("leaves the launching user out, in either spelling", () => {
    expect(otherRecipients(data, "Ann/Acme")).toEqual(["cn=Bob/o=Acme"]);
  });

  it("compares canonical and abbreviated names", () => {
    expect(recipientNamesEqual("cn=Bob/o=Acme", "bob/acme")).toBe(true);
    expect(recipientNamesEqual("cn=Bob/o=Acme", "")).toBe(false);
  });

  it("diffs lists by name, not by spelling", () => {
    expect(recipientDiff(["cn=Bob/o=Acme"], ["Bob/Acme", "cn=Cid/o=Acme"])).toEqual({
      added: ["cn=Cid/o=Acme"],
      removed: [],
    });
  });

  it("shows the directory's spelling, shortened", () => {
    expect(displayRecipient("bob/acme", ["cn=Bob/o=Acme"])).toBe("Bob/Acme");
  });
});
