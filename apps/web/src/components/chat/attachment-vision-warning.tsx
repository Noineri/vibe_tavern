// fork #1 of AttachmentOverflowWarning (attachment-overflow-warning.tsx).
// Same warning chrome; independent advisory copy, no token interpolation.
import { useT } from '../../i18n/context.js';
import { Icons } from '../shared/icons.js';

export function AttachmentVisionWarning() {
  const { t } = useT();
  return (
    <div role="status" className="mb-2 flex min-w-0 items-start gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-warning-text">
      <span className="shrink-0"><Icons.Alert /></span>
      <span className="min-w-0 whitespace-normal break-words">
        {t('attachment_vision_warning')}
      </span>
    </div>
  );
}
