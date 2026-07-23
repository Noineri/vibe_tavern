import { useEffect, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { DiceLaneState, DiceMode } from "../../api/types.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import {
  useDiceDefinitions,
  useDiceLanes,
  useDiceRolling,
} from "../../stores/dice-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { Ic, Icons } from "../shared/icons.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { DiceTray } from "./DiceTray.js";

const EMPTY_LANE: DiceLaneState = { revision: 0, rolls: [] };

export function DicePanel(): ReactNode {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const activeChat = useSnapshotStore((state) => state.activeChat);
  const activeBranch = useSnapshotStore((state) => state.activeBranch);
  const character = useSnapshotStore((state) => state.character);
  const persona = useSnapshotStore((state) => state.persona);
  const chatId = activeChat?.id ?? null;
  const branchId = activeBranch?.id ?? null;
  const enabled = activeChat?.insightsConfig?.diceEnabled ?? false;
  const mode: DiceMode = activeChat?.insightsConfig?.diceMode ?? "normal";
  const definitions = useDiceDefinitions(enabled ? chatId : null, branchId);
  const lanes = useDiceLanes(enabled ? chatId : null, branchId);
  const rolling = useDiceRolling(enabled ? chatId : null, branchId);

  useEffect(() => {
    setExpanded(false);
  }, [branchId, chatId, enabled]);

  if (!enabled || !chatId || !branchId || !definitions || definitions.scripts.length === 0) return null;

  const lane = lanes?.[mode] ?? EMPTY_LANE;
  const readyCount = lane.rolls.filter((roll) => roll.included).length;
  const unresolvedChoose = lane.rolls.some((roll) => roll.included && roll.policy === "choose" && roll.finalAttemptId === null);
  const pillLabel = rolling
    ? t("dice_panel_rolling")
    : unresolvedChoose
      ? t("dice_panel_choose_required")
      : readyCount > 0
        ? t("dice_panel_ready", { count: readyCount })
        : lane.rolls.length > 0
          ? t("dice_panel_excluded_pending", { count: lane.rolls.length })
          : t("dice_panel_roll");

  const tray = (
    <DiceTray
      chatId={chatId}
      branchId={branchId}
      mode={mode}
      definitions={definitions}
      lane={lane}
      character={character ? { id: character.id, name: character.name } : null}
      persona={persona ? { id: persona.id, name: persona.name } : null}
      diceActorBindings={activeChat?.insightsConfig?.diceActorBindings ?? null}
      showTitle={!isMobile}
    />
  );

  return (
    <div className="absolute bottom-full left-1/2 z-20 mb-1 flex -translate-x-1/2 items-center">
      <Popover.Root open={expanded} onOpenChange={setExpanded}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t("dice_panel_title")}
            className={cn(
              "glass-blur flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
              readyCount > 0 && "border-accent/40 bg-accent-dim text-accent-t",
              unresolvedChoose && "border-warning/50 bg-warning-dim text-warning-text",
            )}
          >
            {rolling ? <Icons.regen className="animate-spin-slow" /> : <Ic.dice />}
            <span>{pillLabel}</span>
            <Icons.Caret direction={expanded ? "d" : "u"} />
          </button>
        </Popover.Trigger>
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? undefined}>
            <Popover.Content
              side="top"
              align="center"
              sideOffset={4}
              className="glass-blur z-[220] w-[42rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              {tray}
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>

      {expanded && isMobile && (
        <BottomSheet open={true} onClose={() => setExpanded(false)} title={t("dice_tray_title")}>
          {tray}
        </BottomSheet>
      )}
    </div>
  );
}
