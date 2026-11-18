import { useEffect, useId, useRef } from "react";
import { dialogProps } from "../lib/focusReturn";
import { useEscape } from "./useEscape";

/**
 * An overlay as a modal dialog: the root gets role="dialog", aria-modal and a
 * label from the title pill (titleId), and focus moves to the Back button
 * (back) when the overlay opens. Escape runs `onClose` while this overlay is
 * the top layer. App returns focus to the opener on close.
 */
export function useDialog(onClose?: () => void) {
  const titleId = useId();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, []);
  useEscape(() => onClose?.(), !!onClose);
  return { titleId, back, root: dialogProps(titleId) };
}
