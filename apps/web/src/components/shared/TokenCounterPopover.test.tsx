import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let render: typeof import("@testing-library/react").render;
let TokenCounterPopover: typeof import("./TokenCounterPopover.js").TokenCounterPopover;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ TokenCounterPopover } = await import("./TokenCounterPopover.js"));
});

describe("TokenCounterPopover desktop trigger", () => {
  it("keeps the desktop text counter and its existing state color", () => {
    const { container } = render(
      <TokenCounterPopover
        permanent={100}
        history={25}
        inputTokens={25}
        contextSize={200}
        maxTokens={0}
        availableBudget={200}
        tokenState="mid"
        permanentItems={[]}
      />,
    );

    expect(container.textContent).toBe("100+50 / 200");
    expect(container.querySelector("span")?.getAttribute("class")).toContain("text-warning-text");
  });
});
