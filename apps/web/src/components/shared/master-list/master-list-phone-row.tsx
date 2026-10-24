import { MasterDetailMobileDrillDown } from "../MasterDetailModal.js";
import {
  MasterListRow,
  SortableMasterListRow,
  type MasterListRowProps,
  type SortableMasterListRowProps,
} from "./master-list-row.js";

// forks: 0 — master-list primitive source: the phone drill-down row. Same row
// rules + handle as the desktop row, with the drill-down caret docked in the
// trailing slot (it opens the detail pane; tapping the row selects). Hiding
// drag on the phone is not an option — the handle stays.

export type MasterListPhoneRowProps = MasterListRowProps;

export function MasterListPhoneRow({ onSelect, trailing, ...rowProps }: MasterListPhoneRowProps) {
  return (
    <MasterListRow
      {...rowProps}
      onSelect={onSelect}
      trailing={trailing ?? <MasterDetailMobileDrillDown onSelect={onSelect} className="py-3" />}
    />
  );
}

export type SortableMasterListPhoneRowProps = SortableMasterListRowProps;

export function SortableMasterListPhoneRow({
  onSelect,
  trailing,
  ...rowProps
}: SortableMasterListPhoneRowProps) {
  return (
    <SortableMasterListRow
      {...rowProps}
      onSelect={onSelect}
      trailing={trailing ?? <MasterDetailMobileDrillDown onSelect={onSelect} className="py-3" />}
    />
  );
}
