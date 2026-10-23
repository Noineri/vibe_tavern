/**
 * AgentTurnErrorCard (AGENT_SHELL_POLISH, Wave 3 / AP-13) — the turn-failure
 * card at the feed end: the loud live variant (title + the toast's category
 * description + retry) and the quiet after-reload variant (unanswered title
 * + retry, no description — the category is unknown after a reload).
 *
 * No i18n init in this suite — the default context echoes keys (the
 * permission-card pattern), so the category→description mapping is pinned
 * through the RAW keys, not the English copy.
 */
import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentTurnFailure } from "./use-agent-turn-actions.js";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");
const { AgentTurnErrorCard } = await import("./AgentTurnErrorCard.js");

function renderCard(failure: AgentTurnFailure | null, onRetry?: () => void) {
  const retry = onRetry ?? mock(() => {});
  const utils = render(<AgentTurnErrorCard failure={failure} onRetry={retry} />);
  return { ...utils, retry };
}

describe("AgentTurnErrorCard", () => {
  it("loud variant: failure title + the toast's category description + retry", () => {
    const { getByTestId, getByText } = renderCard({ category: "rate_limit" });

    const card = getByTestId("copilot-error-card");
    expect(card.getAttribute("data-variant")).toBe("failed");
    expect(getByText("copilot_turn_error_title")).toBeDefined();
    // The transient description is the TOAST's key (one derivation — the
    // card renders what the toast rendered for the same category).
    expect(getByTestId("copilot-error-card-description").textContent).toBe(
      "provider_error_transient_desc",
    );
    expect(getByTestId("copilot-error-card-retry").textContent).toContain("retry");
  });

  it("loud variant keeps the auth-category guidance text", () => {
    const { getByTestId } = renderCard({ category: "authentication" });

    expect(getByTestId("copilot-error-card-description").textContent).toBe(
      "provider_error_auth_desc",
    );
  });

  it("loud variant with an undescribed category renders no description (like the bare toast)", () => {
    const { getByTestId, queryByTestId } = renderCard({ category: "unknown" });

    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("failed");
    expect(queryByTestId("copilot-error-card-description")).toBeNull();
    expect(getByTestId("copilot-error-card-retry")).toBeDefined();
  });

  it("quiet variant: unanswered title + retry, no description", () => {
    const { getByTestId, getByText, queryByTestId } = renderCard(null);

    const card = getByTestId("copilot-error-card");
    expect(card.getAttribute("data-variant")).toBe("unanswered");
    expect(getByText("copilot_turn_error_unanswered_title")).toBeDefined();
    expect(queryByTestId("copilot-error-card-description")).toBeNull();
    expect(getByTestId("copilot-error-card-retry")).toBeDefined();
  });

  it("retry click retries (the pane wires it to handleRegenerate)", () => {
    const retry = mock(() => {});
    const { getByTestId } = renderCard({ category: "server_error" }, retry);

    fireEvent.click(getByTestId("copilot-error-card-retry") as HTMLButtonElement);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
