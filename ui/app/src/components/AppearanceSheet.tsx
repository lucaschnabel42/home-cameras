import { CaretLeft, Check } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useState } from "react";
import { useDialog } from "../hooks/useDialog";
import { THEMES, applyTheme, readTheme, saveTheme, type ThemeId } from "../lib/theme";

/**
 * The colour theme of the app on this device. A tap shows the theme at once.
 * Light or dark is not a choice here: it follows the device.
 */
export function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const { titleId, back: backButton, root: dialogRoot } = useDialog(onClose);
  const [current, setCurrent] = useState<ThemeId>(() => readTheme());
  const [kept, setKept] = useState(true);

  const choose = (id: ThemeId) => {
    applyTheme(id);
    setCurrent(id);
    setKept(saveTheme(id));
  };

  return (
    <motion.div className="overlay panel alerts" {...dialogRoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={onClose} ref={backButton} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>Theme</span>
      </div>
      <div className="alerts-body">
        <div className="theme-list" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className="theme-row glass"
              role="radio"
              aria-checked={t.id === current}
              onClick={() => choose(t.id)}
            >
              {/* data-theme here draws the swatch with that theme's own tokens (themes.css) */}
              <span className="theme-swatch" data-theme={t.id} aria-hidden="true">
                <i />
                <i />
              </span>
              <span className="theme-name">
                <b>{t.name}</b>
                <small>{t.note}</small>
              </span>
              {t.id === current && <Check className="theme-check" size={20} weight="bold" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <p className="theme-foot" role="status">
          {kept
            ? "The theme is kept on this device. Light or dark follows the device."
            : "This browser did not keep the choice. The theme lasts until the app closes."}
        </p>
      </div>
    </motion.div>
  );
}
