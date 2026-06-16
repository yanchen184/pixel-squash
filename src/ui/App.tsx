import { useState } from 'react';
import type { Difficulty } from '@/game/input/AIInput';
import type { GameMode } from '@/data/gameState';
import type { MatchConfig } from './GameView';
import { GameView } from './GameView';
import { useIsPortraitPhone } from './useOrientation';

type Screen = 'menu' | 'howto' | 'difficulty' | 'match';

export function App() {
  const [screen, setScreen] = useState<Screen>('menu');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [gameMode, setGameMode] = useState<GameMode>('match');
  const portraitPhone = useIsPortraitPhone();

  // The court is a fixed 16:9 landscape view — on an upright phone it would shrink
  // to a sliver, so gate the WHOLE app behind a rotate prompt instead of letting any
  // screen render sideways. Desktop / landscape phones fall straight through.
  if (portraitPhone) return <RotatePrompt />;

  const startMatch = (d: Difficulty, mode: GameMode = 'match') => {
    setDifficulty(d);
    setGameMode(mode);
    setScreen('match');
  };

  if (screen === 'menu') {
    return (
      <Center>
        <h1 style={{ fontSize: 48, margin: 0 }}>🎾 Pixel Squash</h1>
        <p style={{ color: '#aaa' }}>像素壁球 · 挑戰電腦對手</p>
        <button style={bigBtn} onClick={() => setScreen('howto')}>開始遊戲</button>
        <button style={{ ...bigBtn, background: '#2a7a4a' }} onClick={() => startMatch('easy', 'practice')}>練習模式</button>
        <button style={ghostBtn} onClick={() => setScreen('howto')}>怎麼玩？</button>
      </Center>
    );
  }

  if (screen === 'howto') {
    return <HowTo onContinue={() => setScreen('difficulty')} onBack={() => setScreen('menu')} />;
  }

  if (screen === 'difficulty') {
    return (
      <Center>
        <h1 style={{ fontSize: 32 }}>選擇難度</h1>
        <div style={{ display: 'flex', gap: 16 }}>
          {(['easy', 'medium', 'hard'] as Difficulty[]).map((d) => (
            <button key={d} style={{ ...bigBtn, ...diffStyle[d] }} onClick={() => startMatch(d, 'match')}>
              {DIFF_LABEL[d]}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={ghostBtn} onClick={() => setScreen('howto')}>怎麼玩？</button>
          <button style={ghostBtn} onClick={() => setScreen('menu')}>← 返回</button>
        </div>
      </Center>
    );
  }

  // match
  const config: MatchConfig = { difficulty, gameMode };
  return <GameView config={config} onExit={() => setScreen('menu')} />;
}

/**
 * Full-screen "rotate your phone" gate shown when a touch device is held upright.
 * The 16:9 court is unplayable in portrait, so we block rather than letterbox it.
 * Re-renders away automatically the moment useIsPortraitPhone flips to landscape.
 */
function RotatePrompt() {
  return (
    <div style={rotateWrap}>
      <div style={{ fontSize: 64, animation: 'pbSpin 2.4s ease-in-out infinite' }}>📱</div>
      <h1 style={{ fontSize: 24, margin: 0 }}>請將手機橫放</h1>
      <p style={{ color: '#aaa', margin: 0, fontSize: 15, textAlign: 'center' }}>
        像素壁球是橫向球場 🎾<br />轉成橫向以獲得最佳體驗
      </p>
      <style>{'@keyframes pbSpin{0%,40%{transform:rotate(0)}60%,100%{transform:rotate(90deg)}}'}</style>
    </div>
  );
}

const rotateWrap: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 18,
  padding: 24,
  boxSizing: 'border-box',
};

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
      {children}
    </div>
  );
}

/**
 * How-to-play screen. Every line here mirrors the real control model in
 * game/input/LocalInput.ts + game/sim/simulate.ts — if controls change there, update
 * this too. The control model (SQUASH):
 *   1. 球種 = 你按哪顆鍵：J 絕殺、K 放小球、L 直線抽、空白鍵 高吊。
 *   2. 揮拍「時機」決定落點，也決定失誤：太早高過界(出界)、太晚打到掛板(tin)。
 *   3. 兩人共用同一塊地板、沒有網；球一定要先打中前牆。球落地彈兩次就輸。
 */
interface HowToProps {
  onContinue: () => void;
  onBack: () => void;
}

function HowTo({ onContinue, onBack }: HowToProps) {
  return (
    <div style={howtoWrap}>
      <h1 style={{ fontSize: 30, margin: '0 0 4px' }}>怎麼玩 🎾</h1>
      <p style={{ color: '#aaa', margin: 0, fontSize: 14 }}>
        球一定要先打中<b>前牆</b>（上方紅帶），且要在掛板線以上、出界線以下。
        逼對手回不到、球在地上彈第二下就得分。先得 11 分（差 2 分）獲勝。<br />
        <b>左手移動跑位、右手按球種鍵揮拍</b>。按哪顆鍵就打哪種球。
      </p>

      <Section title="移動（跑位）">
        <Row k="W A S D ／ 方向鍵" v="跑位。整塊地板都能跑（沒有網、沒有半場），先跑到球的落點圈附近才打得到。" />
        <Row k="手機" v="左下角搖桿移動，右下角四顆球種鍵揮拍。" />
      </Section>

      <Section title="球種 = 你按哪顆鍵（最重要）">
        <Row k="J ＝ 絕殺" v="貼著掛板上沿轟出去，最快最沉。只有球夠高才殺得出來（太低自動變直線抽）。" />
        <Row k="K ＝ 放小球" v="輕碰前牆下緣的貼牆小球。要夠靠近前牆才放得出來（太遠自動變直線抽）。" />
        <Row k="L ＝ 直線抽" v="貼著側牆的平快直線球。任何時候都能打，安全好用。" />
        <Row k="空白鍵 ＝ 高吊" v="高高打上前牆，飄向後角的防守球（預設）。" />
      </Section>

      <Section title="揮拍時機 = 落點 + 失誤">
        <Row k="球落到擊球高度的瞬間按" v="Perfect — 最快最準，落點最刁。" />
        <Row k="揮太早" v="打點太高 → 球飛過出界線，出界送分。" />
        <Row k="揮太晚" v="打點太低 → 球打到掛板（tin），掛板送分。剛剛好才安全。" />
      </Section>

      <Section title="魚躍救球">
        <Row k="Shift" v="撲救 — 飛撲擴大接球範圍，救死角球。但撲完會倒地、爬起來前不能動，耗體力。" />
      </Section>

      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button style={bigBtn} onClick={onContinue}>知道了，選難度 →</button>
        <button style={ghostBtn} onClick={onBack}>← 返回</button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ width: '100%', maxWidth: 560 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#7da0ff', margin: '10px 0 6px' }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: 1.4 }}>
      <span style={{ flex: '0 0 150px', color: '#ffd479', fontWeight: 600 }}>{k}</span>
      <span style={{ color: '#ddd' }}>{v}</span>
    </div>
  );
}

const howtoWrap: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: 24,
  boxSizing: 'border-box',
  overflowY: 'auto',
};

const DIFF_LABEL: Record<Difficulty, string> = { easy: '簡單', medium: '中等', hard: '困難' };
const bigBtn: React.CSSProperties = { padding: '16px 40px', fontSize: 22, fontWeight: 700, background: '#4a6ad0', color: '#fff', border: 'none', borderRadius: 12, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '10px 20px', background: 'transparent', color: '#aaa', border: '1px solid #555', borderRadius: 8, cursor: 'pointer' };
const diffStyle: Record<Difficulty, React.CSSProperties> = {
  easy: { background: '#36a06a' },
  medium: { background: '#c0922b' },
  hard: { background: '#c0392b' },
};
