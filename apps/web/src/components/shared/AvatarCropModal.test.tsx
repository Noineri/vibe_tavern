import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realCropper = await import("react-easy-crop");
mock.module("react-easy-crop", () => ({
	...realCropper,
	default: ({ zoom }: { zoom: number }) => <div data-testid="crop-preview" data-zoom={zoom} />,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AvatarCropModal: typeof import("./AvatarCropModal.js").AvatarCropModal;

beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ AvatarCropModal } = await import("./AvatarCropModal.js"));
});

describe("AvatarCropModal zoom", () => {
	it("formats the zoom bubble to one decimal without rounding the live preview value", () => {
		const view = render(
			<AvatarCropModal imageUrl="blob:avatar" onConfirm={() => {}} onCancel={() => {}} />,
		);
		const zoom = view.getByRole("slider") as HTMLInputElement;
		const thumb = zoom.closest("[data-slider-thumb]");
		expect(thumb?.querySelectorAll("[data-slider-bubble]")).toHaveLength(1);
		expect(thumb?.querySelector("[data-slider-bubble]")?.textContent).toBe("×1.0");
		expect(view.getByTestId("crop-preview").getAttribute("data-zoom")).toBe("1");
		fireEvent.change(zoom, { target: { value: "1.63" } });
		expect(thumb?.querySelector("[data-slider-bubble]")?.textContent).toBe("×1.6");
		expect(zoom.value).toBe("1.63");
		expect(view.getByTestId("crop-preview").getAttribute("data-zoom")).toBe("1.63");
	});

	it("updates the crop preview immediately from the shared zoom slider", () => {
		const { getByRole, getByTestId } = render(
			<AvatarCropModal imageUrl="blob:avatar" onConfirm={() => {}} onCancel={() => {}} />,
		);
		const zoom = getByRole("slider") as HTMLInputElement;

		expect(zoom.min).toBe("1");
		expect(zoom.max).toBe("3");
		expect(zoom.step).toBe("0.01");
		fireEvent.change(zoom, { target: { value: "1.75" } });
		expect(getByTestId("crop-preview").getAttribute("data-zoom")).toBe("1.75");
	});
});
