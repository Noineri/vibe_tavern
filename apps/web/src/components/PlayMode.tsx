import { InputArea } from "./InputArea.js";
import { MessageList } from "./MessageList.js";
import type { PlayModeProps } from "./play-mode-types.js";

export function PlayMode(input: PlayModeProps) {
  return (
    <>
      <MessageList {...input.messageList} />
      <InputArea {...input.inputArea} />
    </>
  );
}