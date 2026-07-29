import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let MessageReasoning: typeof import("./MessageReasoning.js").MessageReasoning;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ MessageReasoning } = await import("./MessageReasoning.js"));
});

describe("MessageReasoning disclosure", () => {
  it("opens and collapses the real reasoning body", async () => {
    const { getByText, queryByText } = render(
      <MessageReasoning reasoning="private chain" variant="minimal" />,
    );
    expect(queryByText("private chain")).toBeNull();

    fireEvent.click(getByText("reasoning"));
    expect(getByText("private chain")).toBeTruthy();

    fireEvent.click(getByText("reasoning"));
    await waitFor(() => expect(queryByText("private chain")).toBeNull(), { timeout: 5000 });
  }, { timeout: 10000 });
});
