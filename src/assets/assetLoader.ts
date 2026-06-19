/**
 * Lightweight asset manifest and loader for pixel-squash generated sprite sheets.
 *
 * Design:
 * - All image keys are defined statically in ASSET_MANIFEST.
 * - loadAssets() fires all loads in parallel; errors are silently swallowed so
 *   the game falls back to procedural rendering if any image is missing.
 * - getImage(key) returns the HTMLImageElement if loaded, else null.
 * - Crop rectangles for sprite sheets are co-located here so the renderer
 *   doesn't need external atlas JSON.
 */

// ---- Manifest ----

/** All registered asset keys. */
export type AssetKey =
  | 'ball_trail_sheet'
  | 'shot_trajectory_sheet'
  | 'wall_impact_sheet'
  | 'swing_hit_sheet'
  | 'court_base'
  | 'court_base_v3'
  | 'court_material_base'
  | 'court_bg_no_glass'
  | 'court_lines'
  | 'player_core'
  | 'player_lunge'
  | 'player_lateral'
  | 'player_backview'
  | 'opponent_core'
  | 'court_glass'
  | 'audience_side'
  | 'player_movement'
  | 'player_actions_v2';

/**
 * Resolve asset URLs via `new URL(path, import.meta.url)` so Vite treats each
 * PNG as a module dependency, hashes it, and copies it into dist/assets during
 * production builds.  Plain string literals like '/src/assets/…' are NOT
 * processed by Vite's asset pipeline and won't appear in dist.
 */
const ASSET_URLS: Record<AssetKey, string> = {
  ball_trail_sheet:        new URL('./generated/ball/ball_and_trail_sheet_v1.png',                   import.meta.url).href,
  shot_trajectory_sheet:   new URL('./generated/ball/shot_trajectory_vfx_sheet_v1.png',              import.meta.url).href,
  wall_impact_sheet:       new URL('./generated/vfx/wall_impact_vfx_sheet_v1.png',                   import.meta.url).href,
  swing_hit_sheet:         new URL('./generated/vfx/swing_hit_movement_vfx_sheet_v1.png',            import.meta.url).href,
  court_base:              new URL('./generated/court/court_four_wall_base_v2_connected_outlines.png', import.meta.url).href,
  court_base_v3:           new URL('./generated/court/court_four_wall_base_v3_playable.png',           import.meta.url).href,
  court_material_base:     new URL('./generated/court/court_material_base_v4_no_lines.png',            import.meta.url).href,
  court_bg_no_glass:       new URL('./generated/court/court_bg_no_glass_v1.png',                       import.meta.url).href,
  court_lines:             new URL('./generated/court/court_lines_connected_outlines_v2.png',         import.meta.url).href,
  player_core:             new URL('./generated/player/player_core_moves_sheet_v1.png',               import.meta.url).href,
  player_lunge:            new URL('./generated/player/player_forward_lunge_sheet_v1.png',            import.meta.url).href,
  player_lateral:          new URL('./generated/player/player_lateral_rear_sheet_v1.png',             import.meta.url).href,
  player_backview:         new URL('./generated/player/player_backview_sheet_v1.png',                 import.meta.url).href,
  opponent_core:           new URL('./generated/player/opponent_core_moves_sheet_v1.png',             import.meta.url).href,
  court_glass:             new URL('./generated/court/court_glass_foreground_v1.png',                  import.meta.url).href,
  audience_side:           new URL('./generated/audience/audience_side_v2.png',                        import.meta.url).href,
  player_movement:         new URL('./generated/player/player_movement_sheet_v1.png',                  import.meta.url).href,
  player_actions_v2:       new URL('./generated/player/player_actions_v2_sheet_debg.png',               import.meta.url).href,
};

// ---- Crop rectangles ----

/** A source rectangle crop for a sprite sheet frame: { sx, sy, sw, sh }. */
export type Crop = { sx: number; sy: number; sw: number; sh: number };

/**
 * Ball and trail sheet (1672 × 941):
 *   Laid out as a 5-column × 4-row grid.
 *   Row 0: ball ghost frames (idle → fast)
 *   Row 1: horizontal trail frames
 *   Row 2: arc trail frames
 *   Row 3: impact flash frames
 *
 * Sheet is 1672 × 941; each cell is ~334 × 235.
 */
const BALL_CELL_W = 334;
const BALL_CELL_H = 235;

export function ballGhostCrop(frameIdx: number): Crop {
  const col = frameIdx % 5;
  return { sx: col * BALL_CELL_W, sy: 0, sw: BALL_CELL_W, sh: BALL_CELL_H };
}

export function ballTrailCrop(frameIdx: number): Crop {
  const col = frameIdx % 5;
  return { sx: col * BALL_CELL_W, sy: BALL_CELL_H, sw: BALL_CELL_W, sh: BALL_CELL_H };
}

/**
 * Wall impact VFX sheet (1672 × 941):
 *   5-column × 4-row grid; each frame is ~334 × 235.
 *   Row 0: ring expansion frames (0-4)
 *   Row 1: spark burst frames (5-9)
 */
const VFX_CELL_W = 334;
const VFX_CELL_H = 235;

export function wallImpactCrop(frameIdx: number): Crop {
  const row = frameIdx < 5 ? 0 : 1;
  const col = frameIdx % 5;
  return { sx: col * VFX_CELL_W, sy: row * VFX_CELL_H, sw: VFX_CELL_W, sh: VFX_CELL_H };
}

/**
 * Swing/hit movement VFX sheet (1672 × 941):
 *   5-column × 4-row grid. Row 0 = drive/lob arcs, row 1 = drop/volley flashes.
 */
export function swingHitCrop(frameIdx: number): Crop {
  const col = frameIdx % 5;
  const row = Math.floor(frameIdx / 5) % 4;
  return { sx: col * VFX_CELL_W, sy: row * VFX_CELL_H, sw: VFX_CELL_W, sh: VFX_CELL_H };
}

// ---- Player sprite crops ----
// All three player sheets are 1672×941, laid out as a 4-column × 3-row grid.
// Each cell is 418×314 px.

const PLAYER_CELL_W = 418;
const PLAYER_CELL_H = 314;

function playerCrop(col: number, row: number): Crop {
  return {
    sx: col * PLAYER_CELL_W,
    sy: row * PLAYER_CELL_H,
    sw: PLAYER_CELL_W,
    sh: PLAYER_CELL_H,
  };
}

/**
 * player_forward_lunge_sheet_v1 — blue/navy player.
 * Row 0: running approach (cols 0-3).
 * Row 1: mid-lunge / reach poses.
 * Row 2: deep dive / floor slide.
 */
export const PLAYER_LUNGE_CROPS = {
  run:      playerCrop(1, 0), // mid-stride run
  lunge:    playerCrop(1, 1), // forward lunge reach
  dive:     playerCrop(2, 2), // full dive / slide
} as const;

/**
 * player_lateral_rear_sheet_v1 — blue/navy player, lateral/ready poses.
 * Row 0: ready stance, lateral move.
 * Row 1: swing / backhand.
 * Row 2: low slide.
 */
export const PLAYER_LATERAL_CROPS = {
  ready:    playerCrop(0, 0), // low ready stance
  lateral:  playerCrop(1, 0), // lateral dash
  swing:    playerCrop(2, 1), // swing / forehand
} as const;

/**
 * player_backview_sheet_v1 — dark navy back-view player.
 * 4-column × 3-row grid (same 418×314 cell size).
 * Row 0: run / lateral dash poses.
 * Row 1: ready stance / forehand swing.
 * Row 2: dive / lunge.
 */
export const PLAYER_BACKVIEW_CROPS = {
  run:      playerCrop(2, 0), // lateral run (row 0 col 2)
  ready:    playerCrop(1, 1), // ready stance (row 1 col 1)
  swing:    playerCrop(3, 1), // swing (row 1 col 3)
  dive:     playerCrop(0, 2), // dive / lunge (row 2 col 0)
} as const;

/**
 * player_actions_v2_sheet — dark-navy back-view player (faces front wall, back to
 * camera). 4-column × 3-row grid (418×314 cells). The per-cell content was confirmed
 * by opening the image; the mapping below follows the ACTUAL pose in each cell, not
 * the raw grid order:
 *   (0,0) idle_a stand-ready, racket down      (1,0) idle_b breathing, racket at side
 *   (2,0) left turn side swing                 (3,0) right forward lunge stride
 *   (0,1) low-left crouch step (left move)     (1,1) very upright ready, racket down
 *   (2,1) high overhead kill swing             (3,1) side drive swing
 *   (0,2) low side boast swing                 (1,2) big reaching drop/lunge
 *   (2,2) low ground dive save                 (3,2) low crouch ready
 */
export const PLAYER_ACTIONS_V2_CROPS = {
  idleA:      playerCrop(0, 0), // breathing frame A (racket down)
  idleB:      playerCrop(1, 0), // breathing frame B (racket at side)
  ready:      playerCrop(1, 1), // upright neutral ready
  runLeft:    playerCrop(0, 1), // low-left crouch step (move left)
  runRight:   playerCrop(3, 0), // right forward lunge stride (move right)
  swingKill:  playerCrop(2, 1), // overhead kill (also lob)
  swingDrop:  playerCrop(1, 2), // big reaching drop / lunge
  swingDrive: playerCrop(3, 1), // side drive swing
  swingBoast: playerCrop(0, 2), // low side boast swing
  dive:       playerCrop(2, 2), // ground dive save
  readyLow:   playerCrop(3, 2), // low crouch ready
} as const;

/**
 * opponent_core_moves_sheet_v1 — white/red opponent.
 * Row 0: ready, reach, lunge.
 * Row 1: swing, volley.
 * Row 2: slide.
 */
export const OPPONENT_CROPS = {
  ready:    playerCrop(0, 0), // standing ready
  run:      playerCrop(2, 0), // reaching / striding
  swing:    playerCrop(1, 1), // forehand swing
  dive:     playerCrop(1, 2), // low dive
} as const;

// ---- Loader ----

const _cache = new Map<AssetKey, HTMLImageElement>();
const _failed = new Set<AssetKey>();
let _loadPromise: Promise<void> | null = null;

/**
 * Preload all registered assets. Safe to call multiple times; subsequent calls
 * return the same promise. Never rejects — failed images are silently dropped.
 */
export function loadAssets(): Promise<void> {
  if (_loadPromise) return _loadPromise;

  const tasks = (Object.entries(ASSET_URLS) as [AssetKey, string][]).map(
    ([key, url]) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          _cache.set(key, img);
          resolve();
        };
        img.onerror = () => {
          _failed.add(key); // silently skip; procedural fallback kicks in
          resolve();
        };
        img.src = url;
      }),
  );

  _loadPromise = Promise.all(tasks).then(() => undefined);
  return _loadPromise;
}

/**
 * Return the loaded HTMLImageElement for the given key, or null if not yet
 * loaded / failed to load (caller must use procedural fallback).
 */
export function getImage(key: AssetKey): HTMLImageElement | null {
  return _cache.get(key) ?? null;
}

/** True once all registered assets have resolved (success or failure). */
export function areAssetsReady(): boolean {
  return _loadPromise !== null &&
    _cache.size + _failed.size === Object.keys(ASSET_URLS).length;
}
