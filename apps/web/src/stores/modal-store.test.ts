import { beforeEach, describe, expect, test } from "vitest";
import { useModalStore } from "./modal-store.js";

beforeEach(() => {
  useModalStore.setState({ isProviderModalOpen: false, isCoauthorProviderModalOpen: false, providerModalOrigin: null, coauthorResumeProfileId: null });
});

describe("Co-Author connection return flow", () => {
  test("marks only an atomic Co-Author handoff as returnable", () => {
    useModalStore.getState().setIsProviderModalOpen(true);
    expect(useModalStore.getState().providerModalOrigin).toBeNull();

    useModalStore.getState().openProviderModalFromCoauthor();
    expect(useModalStore.getState()).toMatchObject({ isProviderModalOpen: true, isCoauthorProviderModalOpen: false, providerModalOrigin: "coauthor" });
  });

  test("returns atomically and consumes the created-profile marker once", () => {
    useModalStore.getState().openProviderModalFromCoauthor();
    useModalStore.getState().returnToCoauthorProviderModal("new_profile");
    expect(useModalStore.getState()).toMatchObject({ isProviderModalOpen: false, isCoauthorProviderModalOpen: true, providerModalOrigin: null });
    expect(useModalStore.getState().consumeCoauthorResumeProfileId()).toBe("new_profile");
    expect(useModalStore.getState().consumeCoauthorResumeProfileId()).toBeNull();
  });
});
