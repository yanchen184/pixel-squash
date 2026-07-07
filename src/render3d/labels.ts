/** 回合結束原因的中文標籤(重播檢視器與正式遊戲共用) */
import type { DeadReason } from '../engine/rules';

export const REASON_LABEL: Record<DeadReason, string> = {
  tin: '打中 tin',
  out: '出界',
  'not-front-wall': '沒到前牆',
  'double-bounce': '兩彈未接',
  'serve-fault-front': '發球失誤',
  'serve-fault-box': '發球落點失誤',
};
