import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

// RTL must load AFTER useDomEnv() registers happy-dom — a static top-level
// import lets @testing-library/dom bind to the missing document and silently
// break event dispatch (probe-verified: keyDown never reaches the handler).
useDomEnv();

const { fireEvent, render } = await import("@testing-library/react");
const { InlineRenameInput } = await import("./InlineRenameInput.js");
const { SearchInput } = await import("./SearchInput.js");

/** FS-8c acceptance: the two designed compact families carry their canon in
 *  the primitive, not at call sites. If these pins break, a dialect crept
 *  back into a list row or a toolbar. */
describe("FS-8c InlineRenameInput carries the rename canon", () => {
  it("renders the compact accent-bordered single-line canon", () => {
    const { getByRole } = render(<InlineRenameInput value="draft" onChange={() => {}} />);
    const input = getByRole("textbox") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.className).toContain("border-accent");
    expect(input.className).toContain("py-[5px]");
    expect(input.className).toContain("text-[calc(var(--ui-fs)-2px)]");
    expect(input.className).toContain("w-full");
  });

  it("forwards caller props (placeholder, testid, key handler) untouched", () => {
    const onKey = mock();
    const { getByTestId } = render(
      <InlineRenameInput
        value=""
        onChange={() => {}}
        placeholder="rename…"
        data-testid="row-rename"
        onKeyDown={onKey}
      />,
    );
    const input = getByTestId("row-rename") as HTMLInputElement;
    expect(input.placeholder).toBe("rename…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onKey).toHaveBeenCalledTimes(1);
  });
});

describe("FS-8c SearchInput carries the search canon (shell + borderless input)", () => {
  it("container owns the chrome; the input inside is borderless", () => {
    const { container, getByRole } = render(<SearchInput value="" onChange={() => {}} />);
    const shell = container.firstElementChild as HTMLDivElement;
    expect(shell.className).toContain("border-border");
    expect(shell.className).toContain("focus-within:border-accent");
    const input = getByRole("textbox") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.className).toContain("border-0");
    expect(input.className).toContain("bg-transparent");
  });

  it("shows the search glass by default; explicit null removes it", () => {
    const withIcon = render(<SearchInput value="" onChange={() => {}} />);
    expect(withIcon.container.querySelector("svg")).toBeTruthy();
    const bare = render(<SearchInput icon={null} value="" onChange={() => {}} />);
    expect(bare.container.querySelector("svg")).toBeFalsy();
  });

  it("forwards input props; className extends the shell, not the input", () => {
    const { container, getByTestId } = render(
      <SearchInput
        value=""
        onChange={() => {}}
        className="mt-1"
        placeholder="find…"
        data-testid="list-search"
      />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain("mt-1");
    const input = getByTestId("list-search") as HTMLInputElement;
    expect(input.placeholder).toBe("find…");
    expect(input.className).not.toContain("mt-1");
  });
});
