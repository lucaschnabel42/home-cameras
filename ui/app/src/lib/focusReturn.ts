/**
 * Focus for the overlays (VoiceOver stays in the open screen).
 *
 * An overlay is a modal dialog named by its title pill. When it opens, focus
 * moves to its Back button (hooks/useDialog.ts). When it closes, focus goes
 * back to the control that opened it. App keeps one focusReturn: when one
 * overlay replaces another (camera view to clip player), the first opener on
 * the home screen is kept, because the second opener is gone.
 */

export interface Focusable {
  focus(options?: FocusOptions): void;
  isConnected?: boolean;
}

export function focusReturn() {
  let opener: Focusable | null = null;
  return {
    /** Keep the element that opened the overlay; a later call does not replace it. */
    remember(el: Focusable | null) {
      if (!opener && el) opener = el;
    },
    /** Focus the opener if it is still on the page, then forget it. */
    restore() {
      const el = opener;
      opener = null;
      if (el && el.isConnected !== false) el.focus({ preventScroll: true });
    },
  };
}

/** The attributes of an overlay root. */
export const dialogProps = (titleId: string) =>
  ({ role: "dialog", "aria-modal": true, "aria-labelledby": titleId }) as const;
