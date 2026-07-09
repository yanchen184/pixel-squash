/**
 * #17 下棋感:落點戰術背書。
 * bot 依 skill.tactical 讀對手站位往「空檔」打(調虎離山)——這是「策略性落點」的
 * 客觀證據,不是宣稱。測法:同一球位、固定 seed,只改對手 X,統計出球水平方向:
 *   - 對手站右 → 出球整體更偏左(躲開對手)
 *   - 對手站左 → 出球整體更偏右
 *   - 不讀對手(undefined)→ 落在兩者之間(舊行為基準)
 * 同時確認 tactical=0 的菜鳥(WEAK)完全不受對手站位影響(盲打)。
 */
import { describe, expect, it } from 'vitest';

import { COURT_W } from '../src/engine/ball';
import { BOT_STRONG, BOT_WEAK, decideShot, type BotSkill } from '../src/engine/bot';
import { createPrng } from '../src/engine/prng';

const BALL_POS = { x: COURT_W / 2, y: 4.0, z: 0.9 };

/** 固定 seed 跑 N 次,回傳出球水平方向(sign vx)平均:>0 偏右、<0 偏左 */
function meanDir(skill: BotSkill, opponentX: number | undefined, n = 400): number {
  const prng = createPrng(123);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const s = decideShot(skill, BALL_POS, prng, opponentX);
    if (s === null) continue;
    sum += Math.sign(s.velocity.x);
    cnt++;
  }
  return cnt === 0 ? 0 : sum / cnt;
}

describe('#17 落點戰術:讀對手站位打空檔', () => {
  it('高手(STRONG)把球送向對手的反側空檔', () => {
    const oppRight = meanDir(BOT_STRONG, COURT_W - 0.6);
    const oppLeft = meanDir(BOT_STRONG, 0.6);
    const blind = meanDir(BOT_STRONG, undefined);
    // 對手在右 → 更偏左(小);對手在左 → 更偏右(大);不讀對手居中
    expect(oppRight).toBeLessThan(blind);
    expect(oppLeft).toBeGreaterThan(blind);
    // 讀站位的兩極差距要明顯(不是雜訊級)
    expect(oppLeft - oppRight).toBeGreaterThan(0.3);
  });

  it('菜鳥(WEAK,tactical=0)盲打:對手站哪都一樣', () => {
    const oppRight = meanDir(BOT_WEAK, COURT_W - 0.6);
    const oppLeft = meanDir(BOT_WEAK, 0.6);
    expect(oppRight).toBe(oppLeft);
  });

  it('決定性:同 seed 同對手位 → 完全重現', () => {
    const a = meanDir(BOT_STRONG, COURT_W - 0.6);
    const b = meanDir(BOT_STRONG, COURT_W - 0.6);
    expect(a).toBe(b);
  });
});
