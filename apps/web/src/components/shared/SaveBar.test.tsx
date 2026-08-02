import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import { SaveButton } from "./SaveBar.js";

useDomEnv();
afterEach(cleanup);

describe("SaveButton feedback", () => {
  test("keeps stable geometry and makes a fast save readable", async () => {
    const view = render(
      <SaveButton dirty={true} saveState="idle" label="save" onClick={() => {}} />,
    );

    const initial = view.getByRole("button", { name: "save" });
    expect(initial.classList.contains("min-w-[124px]")).toBe(true);
    expect(initial.querySelectorAll("[class*='grid-area']")).toHaveLength(3);

    view.rerender(
      <SaveButton dirty={true} saveState="saving" label="save" onClick={() => {}} />,
    );
    await waitFor(() => expect(view.getByRole("button", { name: "saving" })).toBeTruthy());

    view.rerender(
      <SaveButton dirty={false} saveState="saved" label="save" onClick={() => {}} />,
    );
    expect(view.getByRole("button", { name: "saving" })).toBeTruthy();
    await waitFor(() => expect(view.getByRole("button", { name: "saved" })).toBeTruthy());

    const saved = view.getByRole("button", { name: "saved" }) as HTMLButtonElement;
    expect(saved.classList.contains("min-w-[124px]")).toBe(true);
    expect(saved.disabled).toBe(true);
  });
});
