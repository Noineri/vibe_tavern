import { beforeAll, describe, expect, it } from "bun:test";
import { useState } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let AnimatedDisclosure: typeof import("./AnimatedDisclosure.js").AnimatedDisclosure;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AnimatedDisclosure } = await import("./AnimatedDisclosure.js"));
});

function Harness({ keepMounted = false }: { keepMounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>toggle</button>
      <AnimatedDisclosure open={open} keepMounted={keepMounted} data-testid="body">
        <button type="button">body control</button>
      </AnimatedDisclosure>
    </>
  );
}

describe("AnimatedDisclosure", () => {
  it("mounts a default disclosure body only while it is open", () => {
    const { getByText, queryByTestId, getByTestId } = render(<Harness />);
    expect(queryByTestId("body")).toBeNull();

    fireEvent.click(getByText("toggle"));
    expect(getByTestId("body")).toBeTruthy();
  });

  it("keeps retained content mounted but inert and aria-hidden while collapsed", () => {
    const { getByText, getByTestId } = render(<Harness keepMounted />);
    const body = getByTestId("body");
    const control = getByText("body control");

    expect(body.hasAttribute("inert")).toBe(true);
    expect(body.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(getByText("toggle"));
    expect(getByTestId("body")).toBe(body);
    expect(control.isConnected).toBe(true);
    expect(body.hasAttribute("inert")).toBe(false);
    expect(body.getAttribute("aria-hidden")).toBeNull();

    fireEvent.click(getByText("toggle"));
    expect(getByTestId("body")).toBe(body);
    expect(control.isConnected).toBe(true);
    expect(body.hasAttribute("inert")).toBe(true);
    expect(body.getAttribute("aria-hidden")).toBe("true");
  });
});
