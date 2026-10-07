import type { Clip } from './model.js';
export function clipContentDuration(clip: Clip) {
  return Math.max(
    0,
    Math.min(
      clip.duration,
      clip.sourceOut === undefined ? clip.duration : (clip.sourceOut - clip.sourceIn) / clip.speed,
    ),
  );
}
export function clipSourceFrame(clip: Clip, localFrame: number) {
  const frame = clip.sourceIn + localFrame * clip.speed;
  return clip.sourceOut === undefined ? frame : Math.min(frame, clip.sourceOut - 1e-7);
}
export function clipWindow(clip: Clip) {
  return clip.fadeWindow ?? { offset: 0, duration: clip.duration };
}
export function clipGain(clip: Clip, localFrame: number) {
  const window = clipWindow(clip),
    frame = localFrame + window.offset;
  return Math.max(
    0,
    Math.min(
      1,
      clip.fadeIn ? frame / clip.fadeIn : 1,
      clip.fadeOut ? (window.duration - frame) / clip.fadeOut : 1,
    ),
  );
}
