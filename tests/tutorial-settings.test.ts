/**
 * M4 教學步驟機 + 設定持久化:
 * 步驟機是純函式 → 逐步驗「對的事件才推進、錯的事件不動、完成後鎖住」;
 * settings 驗 round-trip 與壞資料回預設(mock localStorage)。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadSettings, saveSettings } from '../src/game3d/settings';
import { advanceTutorial, TUTORIAL_DONE, TUTORIAL_STEPS } from '../src/game3d/tutorial';

describe('教學步驟機', () => {
  it('步驟順序:move → serve → return → quality → shots', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'move',
      'serve',
      'return',
      'quality',
      'shots',
    ]);
  });

  it('對的事件推進一步;錯的事件原地不動', () => {
    // step 0(move):hit 不算,move 才算
    expect(advanceTutorial(0, { type: 'hit', kind: 'serve' })).toBe(0);
    expect(advanceTutorial(0, { type: 'move' })).toBe(1);
    // step 1(serve):一般擊球不算,發球才算
    expect(advanceTutorial(1, { type: 'hit', kind: 'drive' })).toBe(1);
    expect(advanceTutorial(1, { type: 'move' })).toBe(1);
    expect(advanceTutorial(1, { type: 'hit', kind: 'serve' })).toBe(2);
    // step 2(return):發球不算,回擊(含 shovel)算
    expect(advanceTutorial(2, { type: 'hit', kind: 'serve' })).toBe(2);
    expect(advanceTutorial(2, { type: 'hit', kind: 'shovel' })).toBe(3);
    // step 3(quality):sloppy 不算,good/perfect 算
    expect(advanceTutorial(3, { type: 'hit', kind: 'drive', quality: 'sloppy' })).toBe(3);
    expect(advanceTutorial(3, { type: 'hit', kind: 'drive', quality: 'perfect' })).toBe(4);
    // step 4(shots):drive 不算,lob/drop/kill 算
    expect(advanceTutorial(4, { type: 'hit', kind: 'drive', quality: 'good' })).toBe(4);
    expect(advanceTutorial(4, { type: 'hit', kind: 'lob' })).toBe(TUTORIAL_DONE);
  });

  it('完成後任何事件都不再動', () => {
    expect(advanceTutorial(TUTORIAL_DONE, { type: 'move' })).toBe(TUTORIAL_DONE);
    expect(advanceTutorial(TUTORIAL_DONE, { type: 'hit', kind: 'kill' })).toBe(TUTORIAL_DONE);
  });

  it('一場理想教學局:五個事件從頭走到完成', () => {
    let step = 0;
    const script = [
      { type: 'move' },
      { type: 'hit', kind: 'serve' },
      { type: 'hit', kind: 'drive', quality: 'sloppy' },
      { type: 'hit', kind: 'drive', quality: 'good' },
      { type: 'hit', kind: 'drop' },
    ] as const;
    for (const ev of script) step = advanceTutorial(step, ev);
    expect(step).toBe(TUTORIAL_DONE);
  });
});

describe('設定持久化(mock localStorage)', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  it('預設 0.5;存了讀回;超界夾住;壞資料回預設', () => {
    expect(loadSettings().volume).toBe(0.5);
    saveSettings({ volume: 0.8 });
    expect(loadSettings().volume).toBe(0.8);
    localStorage.setItem('pixel-squash.settings.v1', JSON.stringify({ volume: 7 }));
    expect(loadSettings().volume).toBe(1);
    localStorage.setItem('pixel-squash.settings.v1', '{oops');
    expect(loadSettings().volume).toBe(0.5);
  });
});
