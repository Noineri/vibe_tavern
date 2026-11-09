import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });

const { render, fireEvent, waitFor } = await import("@testing-library/react");
const { SoundAlertsSection, registerSoundAlertsSection } = await import("./sound-alerts-section.js");
const { useSoundAlertsStore, DEFAULT_SOUND_ALERTS } = await import("../../stores/sound-alerts-store.js");
const { getSettingsSections } = await import("../../lib/settings-section-registry.js");

// L1: no paths/DBs or module doubles; the real section, store and registry.
// happy-dom ships no Notification and no AudioContext — exactly the hostile
// environments the section must degrade in (block hidden, test button silent).
// The Notification-permission flows install a minimal fake on window and
// remove it in afterAll. i18n is uninitialized: raw keys are the query strings.

// Member-for-member Notification stand-in (happy-dom ships none): the class
// IS assignable to `typeof Notification`, so the window install needs no
// cast. Inert defaults for the members the section never reads.
class FakeNotification extends EventTarget implements Notification {
  static readonly maxActions: number = 0;
  static permission: NotificationPermission = "default";
  static requestPermission = (): Promise<NotificationPermission> =>
    Promise.resolve(FakeNotification.permission);
  readonly actions: ReadonlyArray<NotificationAction> = [];
  readonly body: string = "";
  readonly data: unknown = null;
  readonly dir: NotificationDirection = "auto";
  readonly icon: string = "";
  readonly lang: string = "";
  readonly requireInteraction: boolean = false;
  readonly silent: boolean | null = null;
  readonly tag: string = "";
  readonly title: string = "";
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  onclose: ((this: Notification, ev: Event) => unknown) | null = null;
  onerror: ((this: Notification, ev: Event) => unknown) | null = null;
  onshow: ((this: Notification, ev: Event) => unknown) | null = null;
  constructor(_title: string, _options?: NotificationOptions) {
    super();
  }
  close(): void {}
}

const notificationWindow = window as Window & { Notification?: typeof Notification };
const originalNotification = notificationWindow.Notification;

beforeEach(() => {
  useSoundAlertsStore.setState({ settings: { ...DEFAULT_SOUND_ALERTS } });
  delete notificationWindow.Notification;
});

afterAll(() => {
  if (originalNotification) notificationWindow.Notification = originalNotification;
  else delete notificationWindow.Notification;
  useSoundAlertsStore.setState({ settings: { ...DEFAULT_SOUND_ALERTS } });
});

function installFakeNotification(permission: NotificationPermission): void {
  FakeNotification.permission = permission;
  notificationWindow.Notification = FakeNotification;
}

describe("SoundAlertsSection layout", () => {
  test("renders the four event toggles, the volume field and the test button, all off by default", () => {
    const view = render(<SoundAlertsSection />);

    for (const label of [
      "settings_sound_reply_ready",
      "settings_sound_image_ready",
      "settings_sound_queue_finished",
      "settings_sound_generation_error",
    ]) {
      const toggle = view.getByRole("switch", { name: label });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(view.getByText(`${label}_hint`)).toBeTruthy();
    }
    expect(view.getByText("settings_sound_volume")).toBeTruthy();
    expect(view.getByText("settings_sound_test")).toBeTruthy();
    view.unmount();
  });

  test("clicking an event toggle flips the persisted store setting", () => {
    const view = render(<SoundAlertsSection />);

    fireEvent.click(view.getByRole("switch", { name: "settings_sound_reply_ready" }));

    expect(useSoundAlertsStore.getState().settings.replyReady).toBe(true);
    expect(
      view.getByRole("switch", { name: "settings_sound_reply_ready" }).getAttribute("aria-checked"),
    ).toBe("true");
    view.unmount();
  });

  test("the test button stays silent and throws nothing without Web Audio", () => {
    const view = render(<SoundAlertsSection />);

    expect(() => fireEvent.click(view.getByText("settings_sound_test"))).not.toThrow();
    view.unmount();
  });
});

describe("SoundAlertsSection OS notifications", () => {
  test("the notifications block is hidden where the Notification API is absent", () => {
    const view = render(<SoundAlertsSection />);

    expect(view.queryByText("settings_sound_notifications")).toBeNull();
    expect(view.queryByRole("switch", { name: "settings_sound_os_notifications" })).toBeNull();
    view.unmount();
  });

  test("granting permission switches the toggle on", async () => {
    installFakeNotification("granted");
    const view = render(<SoundAlertsSection />);

    fireEvent.click(view.getByRole("switch", { name: "settings_sound_os_notifications" }));
    await waitFor(() => {
      expect(
        view.getByRole("switch", { name: "settings_sound_os_notifications" }).getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(useSoundAlertsStore.getState().settings.osNotifications).toBe(true);
    view.unmount();
  });

  test("denied permission reverts the toggle to off and shows the unblock hint", async () => {
    installFakeNotification("denied");
    const view = render(<SoundAlertsSection />);

    const toggle = view.getByRole("switch", { name: "settings_sound_os_notifications" });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(view.getByText("settings_sound_os_denied_hint")).toBeTruthy();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(useSoundAlertsStore.getState().settings.osNotifications).toBe(false);
    view.unmount();
  });
});

describe("registerSoundAlertsSection", () => {
  test("registers the sound section in the master list", () => {
    const dispose = registerSoundAlertsSection();
    try {
      const section = getSettingsSections().find((candidate) => candidate.id === "sound");
      expect(section?.labelKey).toBe("settings_section_sound");
    } finally {
      dispose();
    }
    expect(getSettingsSections().some((candidate) => candidate.id === "sound")).toBe(false);
  });
});
