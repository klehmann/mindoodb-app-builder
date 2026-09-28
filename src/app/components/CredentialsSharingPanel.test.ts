// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import CredentialsSharingPanel from "@/app/components/CredentialsSharingPanel.vue";

function render(props: Partial<InstanceType<typeof CredentialsSharingPanel>["$props"]> = {}) {
  return mount(CredentialsSharingPanel, {
    props: {
      canStore: true,
      canReadDirectory: true,
      currentUser: "cn=Ann/o=Acme",
      sharedWith: [],
      directoryUsers: ["cn=Ann/o=Acme", "cn=Bob/o=Acme", "cn=Cid/o=Acme"],
      busy: false,
      ...props,
    },
  });
}

describe("CredentialsSharingPanel", () => {
  it("asks for the directory when it may not read it", () => {
    const wrapper = render({ canReadDirectory: false });
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.emitted("loadUsers")).toBeUndefined();
  });

  it("offers everyone but the user and those already on the list", () => {
    const wrapper = render({ sharedWith: ["cn=Bob/o=Acme"] });
    expect(wrapper.emitted("loadUsers")).toHaveLength(1);
    const options = wrapper.findAll("option").map((option) => option.text());
    expect(options).toEqual(["Choose a person…", "Cid/Acme"]);
  });

  it("saves the new list only when asked, and warns when someone is taken off", async () => {
    const wrapper = render({ sharedWith: ["cn=Bob/o=Acme"] });
    const save = () => wrapper.findAll("button").find((button) => button.text() === "Save sharing")!;
    expect(save().attributes("disabled")).toBeDefined();

    await wrapper.find("select").setValue("cn=Cid/o=Acme");
    await wrapper.find("form").trigger("submit");
    await wrapper.findAll("button").find((button) => button.text().startsWith("Bob/Acme"))!.trigger("click");

    expect(wrapper.find(".warn").exists()).toBe(true);
    await save().trigger("click");
    expect(wrapper.emitted("share")).toEqual([[["cn=Cid/o=Acme"]]]);
  });
});
