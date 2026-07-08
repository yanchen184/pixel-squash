/**
 * 程序化音效(WebAudio 合成,零素材檔):擊球、牆、地板、得分、終局。
 * 渲染側模組 —— 引擎完全不知道聲音存在;吃 SimEvent 就能出聲。
 * AudioContext 依瀏覽器政策要等第一次使用者手勢才 resume。
 */
import type { HitQuality } from '../engine/quality';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private volume = 0.5;

  /** 綁在第一次使用者手勢(選難度按鈕)上 */
  unlock(): void {
    if (this.ctx === null) {
      const Ctor = window.AudioContext ?? (window as unknown as Record<string, unknown>).webkitAudioContext;
      if (Ctor === undefined) return;
      this.ctx = new (Ctor as typeof AudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 0..1;AudioContext 還沒醒也先記住,unlock 時套用 */
  setVolume(v: number): void {
    this.volume = v < 0 ? 0 : v > 1 ? 1 : v;
    if (this.master !== null) this.master.gain.value = this.volume;
  }

  private noise(): AudioBuffer | null {
    if (this.ctx === null) return null;
    if (this.noiseBuf === null) {
      const len = Math.floor(this.ctx.sampleRate * 0.2);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuf;
  }

  /** 短促音頭:freq 起、快速滑落,gain 指數衰減 */
  private blip(freq: number, endFreq: number, dur: number, gain: number, type: OscillatorType): void {
    if (this.ctx === null || this.master === null) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** 噪聲拍面:模擬拍線/牆面的「啪」 */
  private thwack(dur: number, gain: number, filterFreq: number): void {
    const buf = this.noise();
    if (this.ctx === null || this.master === null || buf === null) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = filterFreq;
    bp.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  /** 擊球:音高隨球速,perfect 疊一記高頻 ping */
  racketHit(speed: number, quality?: HitQuality): void {
    const k = Math.min(speed / 38, 1); // 38 m/s ≈ 殺球滿速
    this.thwack(0.07, 0.65, 900 + 1400 * k);
    this.blip(220 + 240 * k, 90, 0.09, 0.35, 'triangle');
    if (quality === 'perfect') this.blip(1560, 1180, 0.16, 0.28, 'sine');
    else if (quality === 'sloppy') this.blip(130, 60, 0.14, 0.3, 'sawtooth');
  }

  wallHit(speed: number): void {
    const k = Math.min(speed / 30, 1);
    this.thwack(0.06, 0.22 + 0.25 * k, 320 + 500 * k);
  }

  floorBounce(): void {
    this.thwack(0.05, 0.18, 240);
    this.blip(150, 70, 0.06, 0.15, 'sine');
  }

  /** 得分:自己贏上行雙音,輸掉下行 */
  score(win: boolean): void {
    if (win) {
      this.blip(523, 523, 0.1, 0.3, 'square');
      window.setTimeout(() => this.blip(784, 784, 0.16, 0.3, 'square'), 110);
    } else {
      this.blip(392, 392, 0.1, 0.22, 'square');
      window.setTimeout(() => this.blip(262, 262, 0.18, 0.22, 'square'), 110);
    }
  }

  /** 終局:贏 = 三連上行號角;輸 = 低音收尾 */
  matchEnd(win: boolean): void {
    if (win) {
      this.blip(523, 523, 0.14, 0.32, 'square');
      window.setTimeout(() => this.blip(659, 659, 0.14, 0.32, 'square'), 150);
      window.setTimeout(() => this.blip(784, 784, 0.3, 0.34, 'square'), 300);
    } else {
      this.blip(330, 330, 0.16, 0.26, 'square');
      window.setTimeout(() => this.blip(220, 165, 0.4, 0.26, 'square'), 180);
    }
  }
}
