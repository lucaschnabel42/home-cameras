import type { HomeView } from "../lib/homeView";
import type { Section } from "../lib/names";

/**
 * The chips above the cameras of Home: "All", "By group", then each group
 * that holds a camera. The caller shows them only when a group holds a
 * camera. The choice is kept on this device (lib/homeView.ts); it does not
 * filter the activity list.
 */
export function HomeViewChips({ view, groups, onView }: { view: HomeView; groups: Section[]; onView: (v: HomeView) => void }) {
  return (
    <div className="chips home-view" role="group" aria-label="Show cameras">
      <button className="chip" aria-pressed={view.kind === "all"} onClick={() => onView({ kind: "all" })}>
        All
      </button>
      <button className="chip" aria-pressed={view.kind === "groups"} onClick={() => onView({ kind: "groups" })}>
        By group
      </button>
      {groups.map((g) =>
        g.id ? (
          <button key={g.id} className="chip" aria-pressed={view.kind === "group" && view.id === g.id} onClick={() => onView({ kind: "group", id: g.id! })}>
            {g.name}
          </button>
        ) : null,
      )}
    </div>
  );
}
