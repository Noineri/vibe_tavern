import { describe, expect, it } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import { AddButton } from "./add-button.js";

useDomEnv();

const { render } = await import("@testing-library/react");

describe("AddButton", () => {
  it("preserves the complete default button DOM and composed class string", () => {
    const { container } = render(<AddButton onClick={() => {}}>Add rule</AddButton>);

    expect(container.innerHTML).toBe(
      '<button type="button" class="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent">Add rule</button>',
    );
  });
});
