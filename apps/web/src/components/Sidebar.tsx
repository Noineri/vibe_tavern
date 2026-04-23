import type { ChatId } from "@rp-platform/domain";
import type { ChatListItem } from "../app-client.js";
import type { CharacterTab } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";

interface SidebarProps {
  sidebarCollapsed: boolean;
  activeChatId: ChatId;
  characterTabs: CharacterTab[];
  chats: ChatListItem[];
  personaName: string;
  onToggleCollapsed: () => void;
  onSwitchChat: (chatId: ChatId) => void;
}

export function Sidebar(input: SidebarProps) {
  return (
    <aside className={`sidebar${input.sidebarCollapsed ? " is-collapsed" : ""}`}>
      <div className="sb-head">
        <div className="logo-mark">r</div>
        {!input.sidebarCollapsed && <div className="app-name">RP Platform</div>}
        <button
          className="iBtn"
          aria-label={input.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={input.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={input.onToggleCollapsed}
        >
          <Icons.Caret direction={input.sidebarCollapsed ? "r" : "l"} />
        </button>
      </div>

      {!input.sidebarCollapsed && (
        <>
          <section className="sb-sec">
            <div className="sb-lbl">Characters</div>
            {input.characterTabs.map((character) => (
              <button
                key={character.id}
                className={`sb-item${character.chatId === input.activeChatId ? " act" : ""}`}
                onClick={() => input.onSwitchChat(character.chatId)}
              >
                <span className={`sb-ava${character.chatId === input.activeChatId ? " on" : ""}`}>
                  {initials(character.name)}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{character.name}</span>
              </button>
            ))}
          </section>

          <section className="sb-sec grow">
            <div className="sb-lbl">Chats</div>
            {input.chats.map((chat) => (
              <button
                key={chat.id}
                className={`sb-chat${chat.id === input.activeChatId ? " act" : ""}`}
                onClick={() => input.onSwitchChat(chat.id)}
              >
                <span className="sb-ct">{chat.title}</span>
                <span className="sb-cm">
                  {chat.characterName} - {chat.messageCount} msgs
                </span>
                <span className="sb-cm">{chat.activeBranchLabel}</span>
              </button>
            ))}
          </section>

          <section className="sb-foot">
            <div className="sb-item">
              <span className="sb-ava">Y</span>
              <span>{input.personaName}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--t3)", flexShrink: 0 }}>
                Explorer
              </span>
            </div>
          </section>
        </>
      )}
    </aside>
  );
}
