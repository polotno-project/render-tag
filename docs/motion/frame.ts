import type { TextUnit } from 'render-tag';

/** What the motion loop hands each sample's paintTextUnit, in layout px. */
export interface Frame {
  /** ms since the sample started playing. */
  time: number;
  units: TextUnit[];
  /** The layout's width and content height. */
  width: number;
  height: number;
  /** The pointer over the canvas; `strength` eases to 1 while it hovers and back to 0. */
  pointer: { x: number; y: number; strength: number } | null;
}
