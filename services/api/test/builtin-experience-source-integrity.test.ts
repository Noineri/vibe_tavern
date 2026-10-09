import { describe, expect, test } from "bun:test";
import {
  BREAKOUT_RULES_SOURCE,
  BREAKOUT_VISUAL_SOURCE,
  CONVERSATION_RULES_SOURCE,
  CONVERSATION_VISUAL_SOURCE,
  DURAK_ALT_VISUAL_SOURCE,
  DURAK_CLASSIC_VISUAL_SOURCE,
  DURAK_RULES_SOURCE,
} from "@vibe-tavern/domain/builtins";

function sha256(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

describe("built-in experience source integrity", () => {
  test.each([
    ["Messenger rules", CONVERSATION_RULES_SOURCE, 18_223, "0c59fce02974b15c427253822d4a60dbfac4aacaecff409733e97f7f4a85737a"],
    ["Messenger visual", CONVERSATION_VISUAL_SOURCE, 26_465, "742830eca1c0c495823964999e4f550442d8c4b24ecf42cfb3c2ffdae7805932"],
    ["Breakout rules", BREAKOUT_RULES_SOURCE, 15_578, "22f642a082505916ced29fba7b743808513ce22d64eea21d7d6d494a2f2c93f0"],
    ["Breakout visual", BREAKOUT_VISUAL_SOURCE, 19_159, "4a4b9713849b09582ec8e7e973bdc0c8a2217a8b9f4e92a381bc4d8eac8fe928"],
    ["Durak rules", DURAK_RULES_SOURCE, 26_638, "b1490966ebf1969dc7acf20b3d7108f0e3ff34e1a9f25156de9d529c0e03a02e"],
    ["Durak classic visual", DURAK_CLASSIC_VISUAL_SOURCE, 39_153, "687417f5009427357f4b79ac3e2597f8826454544bfe2db2268d61f1fc67f2f4"],
    ["Durak alternative visual", DURAK_ALT_VISUAL_SOURCE, 41_328, "180ee4bddf3b85ef21de571e0bdc8e17a02c9df72676e9078d3e3b2e639f7ab8"],
  ])("pins the owner's byte-exact %s source", (_name, source, length, hash) => {
    expect(source).toHaveLength(length);
    expect(sha256(source)).toBe(hash);
  });
});