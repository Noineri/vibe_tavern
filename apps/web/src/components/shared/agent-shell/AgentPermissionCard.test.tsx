/**
 * CopilotPermissionCard (SC-23f) — fork #1 of AgentAskCard: the permission
 * gate's states (awaiting/allowed/denied/expired), the send-once decision
 * buttons (Allow PRIMARY, Deny ghost), and the en+ru i18n parity.
 * SC-23g — the meta line's token count is pluralised (the
 * sidechat_event_rp_sync shape: base + suffixed forms, `count` at the call
 * site), pinned byte-exact in both locales and rendered through the real
 * i18next for the RU cardinal rules.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPermissionState } from "../../../stores/agent-turn-store.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();

// CustomTooltip (Radix) never anchors under happy-dom — the reply line's
// OverflowTooltip wraps its text in it. Render the text inline; this test
// pins the card's render contract (that the FULL first line reaches the
// tooltip primitive), not tooltip internals.
const realTooltip = await import("../../../components/shared/Tooltip.js");
// Spread `...real` (R4): files sharing this worker may load the CA-4f graph
// (AttachmentGrid → sent-file-attachment) whose `TooltipProvider` import a
// spread-less factory would break.
mock.module("../../../components/shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { render, fireEvent, act } = await import("@testing-library/react");
const { AgentPermissionCard } = await import("./AgentPermissionCard.js");
const { LocaleProvider } = await import("../../../i18n/context.js");
const { i18next, initI18n } = await import("../../../i18n/i18n.js");

// SC-23g: the plural cases below render through the real i18next (the
// identity-echo default `t` cannot observe plural selection). Booting here
// makes the bundled resources synchronously available from the first render
// (`initAsync` is false); the RU switch happens inside those tests only.
initI18n("en");

afterAll(async () => {
  // R13: the plural tests drive the process-global i18next language; restore
  // the default so no sibling file in the shared worker observes RU.
  await i18next.changeLanguage("en");
});

function permission(over: Partial<AgentPermissionState>): AgentPermissionState {
  return {
    status: "awaiting_permission",
    position: 7,
    variantNumber: 2,
    replyFirstLine: "First line of the swipe",
    promptTokens: 1234,
    presetName: "Preset",
    ...over,
  };
}

function renderCard(
  state: AgentPermissionState,
  opts?: { interactive?: boolean; onDecision?: (d: "allow" | "deny") => void },
) {
  const calls: ("allow" | "deny")[] = [];
  const onDecision = opts?.onDecision ?? ((d: "allow" | "deny") => calls.push(d));
  const utils = render(
    <AgentPermissionCard permission={state} interactive={opts?.interactive ?? true} onDecision={onDecision} />,
  );
  return { ...utils, calls };
}

describe("CopilotPermissionCard (SC-23f)", () => {
  it("interactive awaiting: title + reply line + variant/tokens meta + Allow (primary) + Deny", () => {
    const { getByTestId, getByText } = renderCard(permission({}));
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    // No i18n init in this suite — the default context echoes keys.
    expect(getByTestId("copilot-permission-title").textContent).toBe("copilot_permission_title");
    expect(getByText("First line of the swipe")).toBeDefined();
    expect(getByTestId("copilot-permission-meta").textContent).toBe(
      "copilot_permission_variant · copilot_permission_tokens",
    );
    const allow = getByTestId("copilot-permission-allow");
    const deny = getByTestId("copilot-permission-deny");
    expect(allow.textContent).toBe("copilot_permission_allow");
    expect(deny.textContent).toBe("copilot_permission_deny");
    // Allow is PRIMARY (the modal-footer's confirm idiom); Deny is the
    // ask-skip ghost (never the accent fill).
    expect(allow.className).toContain("bg-accent");
    expect(deny.className).not.toContain("bg-accent");
    // AP-7 frame: the accent left rule while awaiting, phone-size targets.
    expect(card.className).toContain("border-l-accent");
    expect(allow.className).toContain("min-h-[44px]");
    expect(deny.className).toContain("min-h-[44px]");
  });

  it("Allow sends its decision ONCE (the second click is a no-op)", () => {
    const { getByTestId, calls } = renderCard(permission({}));
    const allow = getByTestId("copilot-permission-allow") as HTMLButtonElement;
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(calls).toEqual(["allow"]);
    expect(allow.disabled).toBe(true);
    expect((getByTestId("copilot-permission-deny") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Deny sends its decision ONCE (the second click is a no-op)", () => {
    const { getByTestId, calls } = renderCard(permission({}));
    const deny = getByTestId("copilot-permission-deny") as HTMLButtonElement;
    fireEvent.click(deny);
    fireEvent.click(deny);
    expect(calls).toEqual(["deny"]);
    expect(deny.disabled).toBe(true);
  });

  it("granted renders the muted arrow receipt read-only (the prompt text is never shown)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({ status: "granted" }));
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("allowed");
    // Was: the green "Allowed" label. Now (owner 2026-10-22 frame
    // ruling): the ask's receipt style — muted, no green, arrow prefix.
    expect(getByTestId("copilot-permission-allowed").textContent).toBe("→ copilot_permission_allowed");
    expect(card.className).not.toContain("border-l-accent");
    expect(card.className).not.toContain("success-text");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("denied renders the muted arrow receipt read-only (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({ status: "denied" }));
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("denied");
    // Was: the bare "Denied" label. Now (owner 2026-10-22 frame ruling):
    // the ask's receipt style with the arrow prefix.
    expect(getByTestId("copilot-permission-denied").textContent).toBe("→ copilot_permission_denied");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("awaiting but NOT interactive (superseded / streaming) renders expired (no buttons)", () => {
    const { getByTestId, queryByTestId } = renderCard(permission({}), { interactive: false });
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    // Muted like the ask's expired state — no accent rule.
    expect(card.className).not.toContain("border-l-accent");
    expect(getByTestId("copilot-permission-expired").textContent).toBe("copilot_permission_expired");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-deny")).toBeNull();
  });

  it("i18n parity: every permission-card key exists in en + ru with the plan's wording", () => {
    const enMap = en as Record<string, string>;
    const ruMap = ru as Record<string, string>;
    const expected: Record<string, { en: string; ru: string }> = {
      copilot_permission_title: {
        en: "The assistant wants to read a reply's prompt",
        ru: "Помощник хочет прочитать промпт ответа",
      },
      copilot_permission_allow: { en: "Allow", ru: "Разрешить" },
      copilot_permission_deny: { en: "Deny", ru: "Отказать" },
      copilot_permission_allowed: { en: "Allowed", ru: "Разрешено" },
      copilot_permission_denied: { en: "Denied", ru: "Отказано" },
    };
    for (const [key, wording] of Object.entries(expected)) {
      expect(enMap[key]).toBe(wording.en);
      expect(ruMap[key]).toBe(wording.ru);
    }
    // The interpolated meta keys carry single-brace placeholders in BOTH locales.
    expect(enMap["copilot_permission_variant"]).toContain("{variant}");
    expect(ruMap["copilot_permission_variant"]).toContain("{variant}");
    expect(ruMap["copilot_permission_variant"]).toContain("вариант");
    // SC-23g: the token count is pluralised — base + suffixed forms in both
    // locales (the sidechat_event_rp_sync shape; the call site passes
    // `count` alongside the `{tokens}` placeholder).
    expect(enMap["copilot_permission_tokens"]).toBe("≈{tokens} tokens");
    expect(enMap["copilot_permission_tokens_one"]).toBe("≈{tokens} token");
    expect(enMap["copilot_permission_tokens_other"]).toBe("≈{tokens} tokens");
    expect(ruMap["copilot_permission_tokens"]).toBe("≈{tokens} токенов");
    expect(ruMap["copilot_permission_tokens_one"]).toBe("≈{tokens} токен");
    expect(ruMap["copilot_permission_tokens_few"]).toBe("≈{tokens} токена");
    expect(ruMap["copilot_permission_tokens_many"]).toBe("≈{tokens} токенов");
    expect(ruMap["copilot_permission_tokens_other"]).toBe("≈{tokens} токенов");
    expect(typeof enMap["copilot_permission_expired"]).toBe("string");
    expect(typeof ruMap["copilot_permission_expired"]).toBe("string");
  });
});

describe("CopilotPermissionCard — token count pluralisation (SC-23g)", () => {
  it("RU: the meta line follows the RU cardinal rules (1/21 → токен, 3/1234 → токена, 5 → токенов)", async () => {
    await act(async () => {
      await i18next.changeLanguage("ru");
    });
    // The factory's variantNumber is 2, so the full meta line is the RU
    // variant label · the pluralised token estimate.
    const cases: [number, string][] = [
      [1, "вариант 2 · ≈1 токен"],
      [3, "вариант 2 · ≈3 токена"],
      [5, "вариант 2 · ≈5 токенов"],
      [21, "вариант 2 · ≈21 токен"],
      [1234, "вариант 2 · ≈1234 токена"],
    ];
    for (const [promptTokens, expected] of cases) {
      const { getByTestId, unmount } = render(
        <LocaleProvider>
          <AgentPermissionCard permission={permission({ promptTokens })} interactive onDecision={() => {}} />
        </LocaleProvider>,
      );
      expect(getByTestId("copilot-permission-meta").textContent).toBe(expected);
      unmount();
    }
  });

  it("EN: count 1 renders the singular token form", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    const { getByTestId } = render(
      <LocaleProvider>
        <AgentPermissionCard permission={permission({ promptTokens: 1 })} interactive onDecision={() => {}} />
      </LocaleProvider>,
    );
    expect(getByTestId("copilot-permission-meta").textContent).toBe("variant 2 · ≈1 token");
  });
});

// ─── Page translation (owner follow-up 2026-10-24) ───────────────────────
// behavior change: was → now, basis: AGENT_SHELL_POLISH_PLAN owner follow-up
// 2026-10-24 (page translation). The reply's first line is the USER's RP
// text — it opts back in; the title / meta / buttons are chrome and stay out.
describe("CopilotPermissionCard — page translation (follow-up 2026-10-24)", () => {
  it("reply first line carries translate=yes (user text)", () => {
    const { getByText } = renderCard(permission({}));
    expect(getByText("First line of the swipe").closest("div[translate]")!.getAttribute("translate")).toBe("yes");
  });

  it("chrome carries no opt-in: title, meta and both buttons stay untranslated", () => {
    const { getByTestId } = renderCard(permission({}));
    expect(getByTestId("copilot-permission-title").getAttribute("translate")).toBeNull();
    expect(getByTestId("copilot-permission-meta").getAttribute("translate")).toBeNull();
    expect(getByTestId("copilot-permission-allow").getAttribute("translate")).toBeNull();
    expect(getByTestId("copilot-permission-deny").getAttribute("translate")).toBeNull();
  });
});
