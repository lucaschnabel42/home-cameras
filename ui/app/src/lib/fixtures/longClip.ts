// An evening of activity on one camera, in the shape that Frigate and the
// helper give: 11 review items over about two hours, three saved clips (one
// of 58 minutes that holds 9 of the events), and a title for 10 of the
// events. The ids, the times, and the titles are invented.
import type { ExportItem, ReviewItem } from "../feed";
import type { Summary } from "../helper";

export const LONG_CLIP_REVIEWS: ReviewItem[] = [
  {"id": "1764725335.689823-ev01aa", "camera": "living_room_cam", "start_time": 1764725335.689823, "end_time": 1764726515.838642, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764725335.689823-ev01aa.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764728362.709365-ev02bb", "camera": "living_room_cam", "start_time": 1764728362.709365, "end_time": 1764728470.073135, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764728362.709365-ev02bb.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764728515.679493-ev03cc", "camera": "living_room_cam", "start_time": 1764728515.679493, "end_time": 1764728562.300293, "severity": "detection", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764728515.679493-ev03cc.webp", "data": {"objects": ["dog"], "audio": []}},
  {"id": "1764728640.692969-ev04dd", "camera": "living_room_cam", "start_time": 1764728640.692969, "end_time": 1764730142.521405, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764728640.692969-ev04dd.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764730183.073145-ev05ee", "camera": "living_room_cam", "start_time": 1764730183.073145, "end_time": 1764730187.283975, "severity": "detection", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764730183.073145-ev05ee.webp", "data": {"objects": ["dog"], "audio": []}},
  {"id": "1764730223.878871-ev06ff", "camera": "living_room_cam", "start_time": 1764730223.878871, "end_time": 1764730323.930575, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764730223.878871-ev06ff.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764730364.894299-ev07gg", "camera": "living_room_cam", "start_time": 1764730364.894299, "end_time": 1764730372.710565, "severity": "detection", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764730364.894299-ev07gg.webp", "data": {"objects": ["dog"], "audio": []}},
  {"id": "1764730484.502735-ev08hh", "camera": "living_room_cam", "start_time": 1764730484.502735, "end_time": 1764731389.28106, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764730484.502735-ev08hh.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764731437.103886-ev09jj", "camera": "living_room_cam", "start_time": 1764731437.103886, "end_time": 1764731749.913078, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764731437.103886-ev09jj.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764731830.310052-ev10kk", "camera": "living_room_cam", "start_time": 1764731830.310052, "end_time": 1764731860.48576, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764731830.310052-ev10kk.webp", "data": {"objects": ["person", "dog"], "audio": []}},
  {"id": "1764732746.290538-ev11mm", "camera": "living_room_cam", "start_time": 1764732746.290538, "end_time": 1764732794.476716, "severity": "alert", "thumb_path": "/media/frigate/clips/review/thumb-living_room_cam-1764732746.290538-ev11mm.webp", "data": {"objects": ["person"], "audio": []}},
];

export const LONG_CLIP_EXPORTS: ExportItem[] = [
  {"id": "living_room_cam_clip1a", "camera": "living_room_cam", "name": "wc1;k=e;c=living_room_cam;s=1764732596;e=1764732944;l=person;d=350", "date": 1764732596, "video_path": "/media/frigate/exports/living_room_cam_20251202_212956-20251202_213544_clip1a.mp4", "thumb_path": "/media/frigate/clips/export/living_room_cam_clip1a.webp", "in_progress": false},
  {"id": "living_room_cam_clip2b", "camera": "living_room_cam", "name": "wc1;k=e;c=living_room_cam;s=1764728213;e=1764732010;l=dog,person;d=3798", "date": 1764728213, "video_path": "/media/frigate/exports/living_room_cam_20251202_201653-20251202_212010_clip2b.mp4", "thumb_path": "/media/frigate/clips/export/living_room_cam_clip2b.webp", "in_progress": false},
  {"id": "living_room_cam_clip3c", "camera": "living_room_cam", "name": "wc1;k=e;c=living_room_cam;s=1764724162;e=1764726666;l=dog,person;d=2505", "date": 1764724162, "video_path": "/media/frigate/exports/living_room_cam_20251202_190922-20251202_195106_clip3c.mp4", "thumb_path": "/media/frigate/clips/export/living_room_cam_clip3c.webp", "in_progress": false},
];

export const LONG_CLIP_SUMMARIES: Record<string, Summary> = {
  "1764728362.709365-ev02bb": { title: "Dog walks across the room", summary: "Summary text removed." },
  "1764728515.679493-ev03cc": { title: "Dog walks to the window", summary: "Summary text removed." },
  "1764728640.692969-ev04dd": { title: "Two people sit in the room", summary: "Summary text removed." },
  "1764730183.073145-ev05ee": { title: "Dog lies down", summary: "Summary text removed." },
  "1764730223.878871-ev06ff": { title: "Dog moves to the rug", summary: "Summary text removed." },
  "1764730364.894299-ev07gg": { title: "Dog rests", summary: "Summary text removed." },
  "1764730484.502735-ev08hh": { title: "Person and dog rest", summary: "Summary text removed." },
  "1764731437.103886-ev09jj": { title: "Person walks in, dog follows", summary: "Summary text removed." },
  "1764731830.310052-ev10kk": { title: "Person walks through the room", summary: "Summary text removed." },
  "1764732746.290538-ev11mm": { title: "Person stands at the counter", summary: "Summary text removed." },
};
