import { OrbField } from "./OrbField";

/**
 * The home screen when Frigate has no camera yet: what is missing and the
 * next step, in plain words.
 */
export function NoCameras() {
  return (
    <div className="no-cameras">
      <OrbField />
      <div className="no-cameras-text glass">
        <b>No cameras yet</b>
        <span>The recorder is running, but it has no camera. Add a camera to the recorder, and it shows here.</span>
        <span>The install guide has the steps.</span>
      </div>
    </div>
  );
}
