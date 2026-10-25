import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();

const { fireEvent, render } = await import("@testing-library/react");

installI18nContextSeam();

let ProviderTestHelloButton: typeof import("./ProviderTestHelloButton.js").ProviderTestHelloButton;
beforeAll(async () => {
  ({ ProviderTestHelloButton } = await import("./ProviderTestHelloButton.js"));
});

describe("ProviderTestHelloButton", () => {
  it("renders the idle button and invokes its caller-owned handler", () => {
    let calls = 0;
    const view = render(<ProviderTestHelloButton onTest={() => { calls += 1; }} testing={false} result={null} />);

    fireEvent.click(view.getByRole("button", { name: "test_hi_btn" }));
    expect(calls).toBe(1);
  });

  it("renders the sending state", () => {
    const view = render(<ProviderTestHelloButton onTest={() => {}} testing result={null} />);

    expect(view.getByRole("button", { name: "sending" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders a reply and cuts it at 200 characters", () => {
    const reply = "a".repeat(201);
    const view = render(<ProviderTestHelloButton onTest={() => {}} testing={false} result={{ reply }} />);

    expect(view.baseElement.textContent).toContain(`${"a".repeat(200)}...`);
    expect(view.baseElement.textContent).not.toContain(reply);
  });

  it("renders an error chip", () => {
    const view = render(<ProviderTestHelloButton onTest={() => {}} testing={false} result={{ error: "network failure" }} />);

    expect(view.baseElement.textContent).toContain("network failure");
  });
});
