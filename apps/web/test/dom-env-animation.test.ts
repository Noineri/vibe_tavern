import { expect, test } from "bun:test";
import { useDomEnv } from "./dom-env.js";

useDomEnv();

test("canceling an animation without observing finished does not raise an unhandled rejection", async () => {
  const animation = document.createElement("div").animate({ opacity: [0, 1] }, 1000);
  animation.cancel();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(animation.playState).toBe("idle");
});

test("animation cancellation still rejects finished for callers observing it", async () => {
  const animation = document.createElement("div").animate({ opacity: [0, 1] }, 1000);
  const finished = animation.finished;
  animation.cancel();
  await expect(finished).rejects.toMatchObject({ name: "AbortError" });
});
