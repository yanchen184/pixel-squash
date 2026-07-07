/**
 * M2 生涯天梯:8 階具名 AI,每階 = BotSkill(技術)+ 風格(球路權重/站位/風險傾向)。
 * 純資料(決定性 lint 適用):數值由 tools/dynamics 梯度/公平性/風格辨識測試背書,
 * 不是憑感覺填 —— 改任何一階記得重跑 tests/engine-ladder.test.ts。
 */

import type { BotSkill } from './bot';
import { COURT_W } from './ball';

export interface LadderRung {
  /** 存檔用穩定 key(localStorage 進度綁這個,別改) */
  readonly id: string;
  readonly name: string;
  /** 一句話個性(選單顯示,也是「風格可辨識」的口頭承諾) */
  readonly tagline: string;
  readonly skill: BotSkill;
}

export const LADDER: readonly LadderRung[] = [
  {
    id: 'rookie',
    name: '阿新',
    tagline: '社團新生,只會直線抽球,慢半拍',
    skill: {
      reactionTicks: 18,
      aimNoise: 1.1,
      execNoise: 0.1,
      moveSpeed: 3.0,
      weights: { drive: 4, lob: 2 },
      aimTight: 1.3,
    },
  },
  {
    id: 'wall',
    name: '長城',
    tagline: '龜在後場什麼都撈得回來,高球磨死你',
    skill: {
      reactionTicks: 14,
      aimNoise: 0.8,
      execNoise: 0.07,
      moveSpeed: 3.7,
      weights: { lob: 4, drive: 2.5, drop: 0.5 },
      home: { x: COURT_W / 2, y: 6.9, z: 0 },
      aimTight: 1.2,
    },
  },
  {
    id: 'blade',
    name: '小刀',
    tagline: '黏在前場,小球與斜線板一直放',
    skill: {
      reactionTicks: 13,
      aimNoise: 0.7,
      execNoise: 0.06,
      moveSpeed: 3.7,
      weights: { drop: 3, boast: 2, drive: 2, lob: 1 },
      home: { x: COURT_W / 2, y: 5.0, z: 0 },
    },
  },
  {
    id: 'cannon',
    name: '重砲',
    tagline: '每球都想打死,貼牆殺球,失誤也多',
    skill: {
      reactionTicks: 10,
      aimNoise: 0.55,
      execNoise: 0.05,
      moveSpeed: 4.0,
      weights: { kill: 3.5, drive: 3, drop: 0.8, lob: 0.6 },
      aimTight: 0.9,
    },
  },
  {
    id: 'metronome',
    name: '節拍器',
    tagline: '什麼都會、什麼都準,節奏不會亂',
    skill: {
      reactionTicks: 9,
      aimNoise: 0.4,
      execNoise: 0.04,
      moveSpeed: 4.1,
      weights: { drive: 2.5, kill: 1.5, drop: 1.5, lob: 1.5, boast: 1 },
    },
  },
  {
    id: 'hound',
    name: '獵犬',
    tagline: '反應快到離譜,全場都是牠的',
    skill: {
      reactionTicks: 6,
      aimNoise: 0.45,
      execNoise: 0.038,
      moveSpeed: 4.8,
      weights: { drive: 3, kill: 2, drop: 1.2, lob: 1, boast: 1 },
    },
  },
  {
    id: 'fox',
    name: '老狐狸',
    tagline: '五種球路輪著騙你,重心永遠是錯的',
    skill: {
      reactionTicks: 5,
      aimNoise: 0.3,
      execNoise: 0.034,
      moveSpeed: 4.7,
      weights: { drive: 2, kill: 2, drop: 2, lob: 1.5, boast: 1.8 },
      aimTight: 0.9,
    },
  },
  {
    id: 'asura',
    name: '修羅',
    tagline: '天梯頂點。沒有弱點,只有你露出的破綻',
    skill: {
      reactionTicks: 4,
      aimNoise: 0.24,
      execNoise: 0.032,
      moveSpeed: 5.0,
      weights: { drive: 3.5, kill: 2.5, drop: 1.8, lob: 1.2, boast: 1 },
      aimTight: 0.85,
    },
  },
];
