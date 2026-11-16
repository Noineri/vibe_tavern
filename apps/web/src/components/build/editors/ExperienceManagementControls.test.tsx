import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();
installI18nContextSeam();
const { fireEvent, render } = await import("@testing-library/react");
const { TooltipProvider } = await import("../../shared/Tooltip.js");
const { ExperienceManagementControls } = await import("./ExperienceManagementControls.js");

describe("ExperienceManagementControls", () => {
  it("retains the desktop save-error detail", async () => {
    const { getByText, findByRole } = render(
      <TooltipProvider delayDuration={0}>
        <ExperienceManagementControls
          name="Mini-app" onNameChange={mock()} scriptEnabled enableLocked={false}
          onToggle={mock()} scriptSaveState="error" scriptDirty saveError="Detailed error"
          isMobile={false} resetKey="one" onSave={mock()} onDuplicate={mock()}
          onDelete={mock()} canDelete
        />
      </TooltipProvider>,
    );
    const state = getByText("retry", { selector: "span.text-danger" });
    expect(state.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(state, { pointerType: "mouse" });
    expect((await findByRole("tooltip")).textContent).toBe("Detailed error");
  });
});
