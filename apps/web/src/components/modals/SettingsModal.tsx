import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useModalStore } from "../../stores/modal-store.js";
import {
  getSettingsSections,
  subscribeSettingsSections,
  type SettingsSectionDescriptor,
  type SettingsSectionId,
} from "../../lib/settings-section-registry.js";
import { MasterDetailModal, MasterDetailMobileDrillDown, useMasterDetail } from "../shared/MasterDetailModal.js";
import { MasterList } from "../shared/master-list/master-list.js";
import { MasterListRow } from "../shared/master-list/master-list-row.js";

function SettingsSectionList({ sections, activeId, onSelect, requestedSection, didDrillDown }: {
  sections: SettingsSectionDescriptor[];
  activeId: SettingsSectionId | undefined;
  onSelect: (id: SettingsSectionId) => void;
  requestedSection: SettingsSectionId | null;
  didDrillDown: RefObject<boolean>;
}) {
  const { t } = useT();
  const { isMobile, openDetail } = useMasterDetail();

  useEffect(() => {
    if (isMobile && !didDrillDown.current && sections.some((section) => section.id === requestedSection)) {
      didDrillDown.current = true;
      openDetail();
    }
  }, [isMobile, sections, requestedSection, didDrillDown, openDetail]);

  const select = (id: SettingsSectionId) => {
    onSelect(id);
    if (isMobile) openDetail();
  };

  return (
    <MasterList
      items={sections}
      getId={(section) => section.id}
      dragDisabled
      onReorderItems={(_active, _over, items) => ({ optimisticItems: items, persist: () => {} })}
      renderRow={(section) => (
        <MasterListRow
          selected={section.id === activeId}
          onSelect={() => select(section.id)}
          title={(
            <button
              type="button"
              aria-label={t(section.labelKey)}
              aria-pressed={section.id === activeId}
              className="flex w-full cursor-pointer items-center gap-2 whitespace-normal text-left"
              onClick={() => select(section.id)}
            >
              <span aria-hidden="true" className="flex shrink-0 items-center">{section.icon}</span>
              <span className="min-w-0 break-words">{t(section.labelKey)}</span>
            </button>
          )}
          trailing={<MasterDetailMobileDrillDown onSelect={() => onSelect(section.id)} />}
        />
      )}
    />
  );
}

function OpenSettingsModal({ requestedSection }: { requestedSection: SettingsSectionId | null }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const registered = useSyncExternalStore(subscribeSettingsSections, getSettingsSections, getSettingsSections);
  const sections = useMemo(
    () => registered.filter((section) => !section.platform || section.platform === (isMobile ? "mobile" : "desktop")),
    [registered, isMobile],
  );
  const [selectedId, setSelectedId] = useState(requestedSection);
  const active = sections.find((section) => section.id === selectedId) ?? sections[0];
  // This ref survives the master list's unmount during mobile drill-down.
  // Returning to the list must not replay the opening deep link.
  const didDrillDown = useRef(false);

  return (
    <MasterDetailModal
      isOpen
      onClose={() => useModalStore.getState().setIsSettingsOpen(false)}
      title={t("settings_modal_title")}
      detailTitle={<span className="whitespace-normal break-words">{active ? t(active.labelKey) : t("settings_modal_title")}</span>}
      masterContent={(
        <SettingsSectionList
          sections={sections}
          activeId={active?.id}
          onSelect={setSelectedId}
          requestedSection={requestedSection}
          didDrillDown={didDrillDown}
        />
      )}
      detailContent={active?.render()}
    />
  );
}

/** Mounted once by AppShell; bodies register themselves as they ship. */
export function SettingsModal() {
  const isOpen = useModalStore((s) => s.isSettingsOpen);
  const requestedSection = useModalStore((s) => s.settingsSection);
  const openRequest = useModalStore((s) => s.settingsOpenRequest);
  if (!isOpen) return null;
  return <OpenSettingsModal key={openRequest} requestedSection={requestedSection} />;
}
