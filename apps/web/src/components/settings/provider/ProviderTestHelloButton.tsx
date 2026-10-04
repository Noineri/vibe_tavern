import type { ReactNode } from "react";
import { useT } from "../../../i18n/context.js";
import { Icons } from "../../shared/icons.js";

export interface ProviderTestHelloResult {
  reply?: string;
  error?: string;
}

export interface ProviderTestHelloButtonProps {
  testing: boolean;
  result: ProviderTestHelloResult | null;
  onTest: () => void;
  className?: string;
  buttonClassName?: string;
  buttonTestId?: string;
  resultContainerClassName?: string;
  replyWrapperClassName?: string;
  errorWrapperClassName?: string;
  replyClassName?: string;
  errorClassName?: string;
  replyRenderer?: (reply: string) => ReactNode;
  errorRenderer?: (error: string) => ReactNode;
}

const defaultButtonClassName = "rounded-md border border-border bg-s2 px-4 py-1.5 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50";
const defaultReplyClassName = "inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success italic";
const defaultErrorClassName = "inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger";

/** Shared model-specific test greeting control; callers retain their own send handlers. */
export function ProviderTestHelloButton({
  testing,
  result,
  onTest,
  className,
  buttonClassName = defaultButtonClassName,
  buttonTestId,
  resultContainerClassName,
  replyWrapperClassName,
  errorWrapperClassName,
  replyClassName = defaultReplyClassName,
  errorClassName = defaultErrorClassName,
  replyRenderer,
  errorRenderer,
}: ProviderTestHelloButtonProps) {
  const { t } = useT();
  const truncateReply = (reply: string) => reply.length > 200 ? `${reply.slice(0, 200)}...` : reply;

  const resultContent = result && <>
    {result.reply && (
      <div className={replyWrapperClassName}>
        {replyRenderer?.(result.reply) ?? <span className={replyClassName}>&ldquo;{truncateReply(result.reply)}&rdquo;</span>}
      </div>
    )}
    {result.error && (
      <div className={errorWrapperClassName}>
        {errorRenderer?.(result.error) ?? <span className={errorClassName}><Icons.Close /> {result.error}</span>}
      </div>
    )}
  </>;

  const content = <>
    <button type="button" data-testid={buttonTestId} onClick={onTest} disabled={testing} className={buttonClassName}>
      {testing ? t("sending") : t("test_hi_btn")}
    </button>
    {resultContent && (resultContainerClassName ? <div className={resultContainerClassName}>{resultContent}</div> : resultContent)}
  </>;

  return className ? <div className={className}>{content}</div> : content;
}
