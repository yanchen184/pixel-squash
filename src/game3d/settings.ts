/**
 * M4 設定(渲染殼層):目前只有音量;localStorage 持久化,壞資料回預設。
 */

const KEY = 'pixel-squash.settings.v1';

export interface Settings {
  /** 0..1 */
  readonly volume: number;
}

const DEFAULTS: Settings = { volume: 0.5 };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    const s = JSON.parse(raw) as Partial<Settings>;
    if (typeof s.volume !== 'number' || !Number.isFinite(s.volume)) return DEFAULTS;
    return { volume: s.volume < 0 ? 0 : s.volume > 1 ? 1 : s.volume };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 寫不進去就只活在本次
  }
}
