/**
 * Procedural sound engine — Web Audio API only, no asset files.
 * All sounds are synthesized from oscillators / noise / filters.
 *
 * Call SoundEngine.get() to get the singleton, then trigger sounds by name.
 * The AudioContext is created lazily on first user gesture (browser policy).
 */

export class SoundEngine {
  private static _instance: SoundEngine | null = null;
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private enabled = true;

  static get(): SoundEngine {
    if (!SoundEngine._instance) SoundEngine._instance = new SoundEngine();
    return SoundEngine._instance;
  }

  /** Call once on a user gesture to unlock the AudioContext. */
  unlock(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.7;
    this.masterGain.connect(this.ctx.destination);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.masterGain) this.masterGain.gain.value = on ? 0.7 : 0;
  }

  // ---- Trigger helpers ----

  /** Ball hits the front wall valid zone — bright metallic ping. */
  frontWallHit(velocity = 1): void {
    const ctx = this._ready(); if (!ctx) return;
    const freq = 680 + velocity * 120; // faster = higher pitch
    this._tone(ctx, 'triangle', freq, 0, 0.001, 0.12, 0.6);
    this._tone(ctx, 'sine', freq * 1.5, 0, 0.001, 0.06, 0.3);
  }

  /** Ball hits a side or back wall — duller thud. */
  sideWallHit(): void {
    const ctx = this._ready(); if (!ctx) return;
    this._tone(ctx, 'triangle', 240, 0, 0.001, 0.1, 0.4);
    this._noise(ctx, 0.08, 0.12, 700, 0.25);
  }

  /** Ball bounces on the floor. */
  floorBounce(bounceNum: number): void {
    const ctx = this._ready(); if (!ctx) return;
    const vol = bounceNum === 1 ? 0.5 : 0.3; // second bounce quieter
    this._tone(ctx, 'sine', 160, 0, 0.001, 0.08, vol);
    this._noise(ctx, 0.05, 0.07, 500, vol * 0.6);
  }

  /** Player racket hits the ball — satisfying smack. */
  racketHit(quality: 'perfect' | 'good' | 'early' | 'late' | 'miss'): void {
    const ctx = this._ready(); if (!ctx) return;
    if (quality === 'miss') {
      // Whiff — air swish
      this._noise(ctx, 0.04, 0.08, 2000, 0.18);
      return;
    }
    const pitchMap = { perfect: 520, good: 440, early: 380, late: 360 } as const;
    const volMap   = { perfect: 0.9, good: 0.7, early: 0.5, late: 0.5 } as const;
    const freq = pitchMap[quality];
    const vol  = volMap[quality];
    this._tone(ctx, 'triangle', freq, 0, 0.001, 0.06, vol);
    this._tone(ctx, 'sine', freq * 0.5, 0, 0.001, 0.1, vol * 0.4);
    this._noise(ctx, 0.02, 0.07, 3000, vol * 0.5);
    if (quality === 'perfect') {
      // Extra sparkle overtone
      this._tone(ctx, 'sine', freq * 2, 0.01, 0.001, 0.08, 0.25);
    }
  }

  /** Ball hits the tin (below the board line) — low thud with clang. */
  tinHit(): void {
    const ctx = this._ready(); if (!ctx) return;
    this._tone(ctx, 'sawtooth', 120, 0, 0.001, 0.15, 0.7);
    this._noise(ctx, 0.03, 0.12, 800, 0.5);
  }

  /** Ball goes out — sharp whistle-like descend. */
  outCall(): void {
    const ctx = this._ready(); if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(this.masterGain!);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.18);
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.start(now); osc.stop(now + 0.25);
  }

  /** Point scored — upward ding. */
  pointScored(scoringPlayer: 0 | 1): void {
    const ctx = this._ready(); if (!ctx) return;
    const baseFreq = scoringPlayer === 0 ? 660 : 440; // player wins higher
    [0, 0.1, 0.2].forEach((delay, i) => {
      const freq = baseFreq * [1, 1.25, 1.5][i];
      this._tone(ctx, 'sine', freq, delay, 0.002, 0.15, 0.35);
    });
  }

  /** Match won — short fanfare. */
  matchWon(winner: 0 | 1): void {
    const ctx = this._ready(); if (!ctx) return;
    const root = winner === 0 ? 523 : 392; // C5 or G4
    const delays = [0, 0.12, 0.24, 0.38];
    const ratios = [1, 1.25, 1.5, 2];
    delays.forEach((d, i) => {
      this._tone(ctx, 'triangle', root * ratios[i], d, 0.005, 0.2, 0.4);
    });
  }

  // ---- Low-level primitives ----

  private _ready(): AudioContext | null {
    if (!this.enabled || !this.ctx || !this.masterGain) return null;
    return this.ctx;
  }

  /** One oscillator burst: type, freq, delay, attack, decay, volume. */
  private _tone(
    ctx: AudioContext,
    type: OscillatorType,
    freq: number,
    delay: number,
    attack: number,
    decay: number,
    volume: number,
  ): void {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(this.masterGain!);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
    osc.start(t);
    osc.stop(t + attack + decay + 0.01);
  }

  /** White noise burst through a bandpass filter. */
  private _noise(
    ctx: AudioContext,
    attack: number,
    decay: number,
    filterFreq: number,
    volume: number,
  ): void {
    const t = ctx.currentTime;
    const bufLen = ctx.sampleRate * (attack + decay);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = 1.5;

    const gain = ctx.createGain();
    src.connect(filter); filter.connect(gain); gain.connect(this.masterGain!);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
    src.start(t);
    src.stop(t + attack + decay + 0.01);
  }
}
