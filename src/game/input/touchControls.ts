/**
 * Shared touch-control state for the on-screen joystick + swing button (the
 * Kairo-style mobile UI). The HUD writes intent here; LocalInput merges it with
 * the keyboard each tick. A module-level singleton keeps the React overlay and
 * the Phaser-driven sim decoupled — neither imports the other.
 *
 * Axis convention matches LocalInput's SCREEN mapping (see LocalInput.sample):
 *   screen vertical (joystick up/down)   → moveX   (logic depth axis)
 *   screen horizontal (joystick left/right) → moveY (toward/away from the net)
 */
import type { StrokeId } from '@/data/strokes';

export type TouchIntent = {
  /** screen vertical, -1 up … 1 down (maps to logic moveX). */
  vert: number;
  /** screen horizontal, -1 left … 1 right (maps to logic moveY). */
  horiz: number;
  swing: boolean;
  /**
   * Which stroke the pressed swing button selects. Mobile shows one button per stroke
   * (殺/吊/抽/高遠); pressing it sets both `swing` and this. Defaults to clear so a
   * bare swing is the safe shot. Keyboard players ignore this (they use J/K/L/Space).
   */
  stroke: StrokeId;
  /** Diving save button (魚躍救球). */
  dive: boolean;
};

const state: TouchIntent = { vert: 0, horiz: 0, swing: false, stroke: 'drive', dive: false };

export function setTouchMove(vert: number, horiz: number): void {
  state.vert = clamp(vert);
  state.horiz = clamp(horiz);
}

export function setTouchSwing(swing: boolean, stroke: StrokeId = 'drive'): void {
  state.swing = swing;
  if (swing) state.stroke = stroke;
}

export function setTouchDive(dive: boolean): void {
  state.dive = dive;
}

export function getTouchIntent(): Readonly<TouchIntent> {
  return state;
}

export function resetTouchIntent(): void {
  state.vert = 0;
  state.horiz = 0;
  state.swing = false;
  state.stroke = 'drive';
  state.dive = false;
}

function clamp(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
