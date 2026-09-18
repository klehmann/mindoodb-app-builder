// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AppList from "@/app/components/AppList.vue";
import { EMPTY_APP_RECORD, type StoredAppRecord } from "@/core/appRecords";

function stored(
  overrides: Partial<StoredAppRecord["record"]> = {},
  documentId = "doc-1",
): StoredAppRecord {
  return {
    documentId,
    record: { ...EMPTY_APP_RECORD, appId: "team-notes", label: "Team Notes", ...overrides },
  };
}

function render(props: Partial<InstanceType<typeof AppList>["$props"]> = {}) {
  return mount(AppList, {
    props: { records: [], loading: false, canStore: true, canForget: true, ...props },
  });
}

describe("AppList", () => {
  it("pitches the builder when there is nothing to show yet", () => {
    const wrapper = render();

    expect(wrapper.text()).toContain("Build your first app");
    expect(wrapper.find(".apps__list").exists()).toBe(false);
  });

  it("offers exactly one way to start, whether or not there is a list", () => {
    const starts = (wrapper: ReturnType<typeof render>) =>
      wrapper.findAll("button").filter((button) => button.text() !== "");

    // Empty: the pitch's own button, and nothing in the header repeating it.
    expect(starts(render()).map((button) => button.text())).toEqual(["Describe an app"]);

    // With a list: the header button, plus one row per app.
    const listed = starts(render({ records: [stored()] })).map((button) => button.text());
    expect(listed[0]).toBe("New app");
    expect(listed).toHaveLength(2);
    expect(render({ records: [stored()] }).find("header .apps__new").text()).toBe("New app");
  });

  it("does not show the empty pitch while still looking", () => {
    // An empty list and an unanswered query look the same in the markup, and confusing
    // them tells a returning user their apps are gone.
    const wrapper = render({ loading: true });

    expect(wrapper.text()).toContain("Looking for your apps");
    expect(wrapper.text()).not.toContain("Build your first app");
  });

  it("says how far each app got, in plain words", () => {
    const wrapper = render({
      records: [
        stored({ label: "Half Done" }, "doc-1"),
        stored(
          {
            label: "Shipped",
            repoUrl: "https://github.com/octocat/shipped",
            workerUrl: "https://shipped.acme.workers.dev",
            originReady: true,
            havenInstanceId: "instance-1",
          },
          "doc-2",
        ),
      ],
    });

    const rows = wrapper.findAll(".apps__row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("Not built yet");
    expect(rows[1]!.text()).toContain("Live, added to Haven");
  });

  it("falls back to the app id, then to a placeholder, for an unnamed app", () => {
    const wrapper = render({
      records: [stored({ label: "" }, "doc-1"), stored({ label: "", appId: "" }, "doc-2")],
    });

    const rows = wrapper.findAll(".apps__row-title");
    expect(rows[0]!.text()).toBe("team-notes");
    expect(rows[1]!.text()).toBe("Untitled app");
  });

  it("shows a start date rather than an unparseable timestamp", () => {
    // `createdAt` comes out of a document, so it is a string that may be anything.
    const wrapper = render({
      records: [stored({ createdAt: "not a date" }, "doc-1")],
    });

    expect(wrapper.find(".apps__row-sub").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Invalid Date");
  });

  it("hands the whole record back when a row is opened", async () => {
    const record = stored();
    const wrapper = render({ records: [record] });

    await wrapper.find(".apps__row").trigger("click");

    expect(wrapper.emitted("open")).toEqual([[record]]);
  });

  it("warns that nothing is kept when the database is read-only", () => {
    const wrapper = render({ canStore: false });

    expect(wrapper.text()).toContain("read-only");
  });

  describe("removing an app from the list", () => {
    it("asks first, and removes nothing on the way", async () => {
      const record = stored();
      const wrapper = render({ records: [record] });

      await wrapper.find(".apps__remove").trigger("click");

      expect(wrapper.emitted("forget")).toBeUndefined();
      expect(wrapper.find(".apps__confirm").exists()).toBe(true);
      expect(wrapper.text()).toContain("Remove “Team Notes” from this list?");
    });

    it("says what removal does not touch, which is the point of asking", async () => {
      // The one thing the user needs to know: this is the builder's note, not the app.
      const wrapper = render({ records: [stored()] });

      await wrapper.find(".apps__remove").trigger("click");

      const text = wrapper.find(".apps__confirm").text();
      expect(text).toContain("GitHub");
      expect(text).toContain("Cloudflare");
      expect(text).toContain("Cursor");
      expect(text).toContain("Haven");
    });

    it("removes the app once the user confirms", async () => {
      const record = stored();
      const wrapper = render({ records: [record] });

      await wrapper.find(".apps__remove").trigger("click");
      await wrapper.find(".apps__confirm button.danger").trigger("click");

      expect(wrapper.emitted("forget")).toEqual([[record]]);
      // The question closes with the answer, so a re-rendered list is not still asking.
      expect(wrapper.find(".apps__confirm").exists()).toBe(false);
    });

    it("keeps the app when the user backs out", async () => {
      const wrapper = render({ records: [stored()] });

      await wrapper.find(".apps__remove").trigger("click");
      await wrapper.find(".apps__confirm button.ghost").trigger("click");

      expect(wrapper.emitted("forget")).toBeUndefined();
      expect(wrapper.find(".apps__confirm").exists()).toBe(false);
    });

    it("does not open the app it is about to remove", async () => {
      // The row is a button and the remove button sits next to it, not inside it.
      const wrapper = render({ records: [stored()] });

      await wrapper.find(".apps__remove").trigger("click");

      expect(wrapper.emitted("open")).toBeUndefined();
    });

    it("asks about the row that was clicked, and only that one", async () => {
      const first = stored({ label: "First" }, "doc-1");
      const second = stored({ label: "Second" }, "doc-2");
      const wrapper = render({ records: [first, second] });

      await wrapper.findAll(".apps__remove")[1]!.trigger("click");

      const confirms = wrapper.findAll(".apps__confirm");
      expect(confirms).toHaveLength(1);
      expect(confirms[0]!.text()).toContain("Second");

      await wrapper.find(".apps__confirm button.danger").trigger("click");
      expect(wrapper.emitted("forget")).toEqual([[second]]);
    });

    it("offers no removal on a database this user may only read", () => {
      const wrapper = render({ records: [stored()], canForget: false });

      expect(wrapper.find(".apps__remove").exists()).toBe(false);
    });
  });
});
