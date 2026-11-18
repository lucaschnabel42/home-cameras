import type { ReactNode } from "react";

/** Drifting accent orbs. Pink in light mode, purple in dark mode (tokens in styles.css). */
export function OrbField({ big = false, children }: { big?: boolean; children?: ReactNode }) {
  return (
    <>
      <div className={big ? "orbs big" : "orbs"} aria-hidden="true">
        <i className="orb a" />
        <i className="orb b" />
        <i className="orb c" />
      </div>
      {children}
    </>
  );
}
