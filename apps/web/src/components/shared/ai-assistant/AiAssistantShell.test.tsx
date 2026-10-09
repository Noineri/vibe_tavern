import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");

const realI18n = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
  }),
}));

let AiAssistantShell: typeof import("./AiAssistantShell.js").AiAssistantShell;

beforeAll(async () => {
  ({ AiAssistantShell } = await import("./AiAssistantShell.js"));
});

describe("AiAssistantShell", () => {
  it("keeps the default header and content output unchanged without footer actions", () => {
    const { baseElement, getByRole } = render(
      <AiAssistantShell
        title={<span>Assistant</span>}
        onClose={() => {}}
        streaming={false}
        providerCount={1}
        noProvidersLabel="No providers"
      >
        <p>Content</p>
      </AiAssistantShell>,
    );

    const header = baseElement.querySelector("div.border-b")!;
    const content = baseElement.querySelector("div.flex-1")!;
    expect(header.className).toBe("flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4");
    expect(content.className).toBe("flex-1 overflow-y-auto");
    expect(content.getAttribute("style")).toBe("padding: 20px;");
    expect(baseElement.querySelector("div.border-t")).toBeNull();
    expect(getByRole("button", { name: "cancel_btn" }).className).toBe(
      "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1",
    );
  });

  it("renders structured secondary and primary actions with disabled and busy states", () => {
    let secondaryCalls = 0;
    let primaryCalls = 0;
    const { getByRole } = render(
      <AiAssistantShell
        title={<span>Assistant</span>}
        onClose={() => {}}
        streaming={false}
        providerCount={1}
        noProvidersLabel="No providers"
        secondaryActions={[
          { label: "Cancel", onClick: () => { secondaryCalls++; }, disabled: true },
          { label: "Refine", busyLabel: "Refining", onClick: () => { secondaryCalls++; }, busy: true },
        ]}
        primaryAction={{ label: "Generate", busyLabel: "Generating", onClick: () => { primaryCalls++; }, busy: true }}
      >
        <p>Content</p>
      </AiAssistantShell>,
    );

    const cancel = getByRole("button", { name: "Cancel" });
    const refine = getByRole("button", { name: "Refining" });
    const generate = getByRole("button", { name: "Generating" });
    expect(cancel.getAttribute("disabled")).toBe("");
    expect(refine.getAttribute("disabled")).toBe("");
    expect(refine.getAttribute("aria-busy")).toBe("true");
    expect(generate.getAttribute("disabled")).toBe("");
    expect(generate.getAttribute("aria-busy")).toBe("true");
    expect(cancel.className).toBe(
      "h-[37px] cursor-pointer rounded-md border border-border bg-surface px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 max-md:w-full",
    );
    expect(generate.className).toBe(
      "h-[37px] cursor-pointer rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 max-md:w-full",
    );
    fireEvent.click(cancel);
    fireEvent.click(refine);
    fireEvent.click(generate);
    expect(secondaryCalls).toBe(0);
    expect(primaryCalls).toBe(0);
    const footer = generate.parentElement!;
    expect(footer.className).toBe(
      "flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-md:px-3 max-md:pt-2.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+0.625rem)]",
    );
  });
});
