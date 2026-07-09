/**
 * P3/P4 3D 渲染器:只讀引擎狀態(RenderState),不寫回 —— 渲染層永遠是引擎的旁觀者。
 * 重播檢視器與正式遊戲共用同一個 Render3D;差別只在 RenderState 從哪來
 * (重播 = 預錄 frames,遊戲 = 每 tick 的 GameSim)。
 * P4:程序化球員(player3d)+ 揮拍動畫 + 鏡頭微追蹤球。
 */
import * as THREE from 'three';
import type { Vec3, WallId } from '../engine/ball';
import { COURT_D, COURT_H, COURT_W } from '../engine/ball';
import type { PlayerId } from '../engine/rules';
import type { GameSim } from '../engine/sim';
import { buildCourt } from './court3d';
import { Player3D } from './player3d';
import { Crowd, ImpactPool, makeSpritePlayerA, makeSpritePlayerB, SpritePlayer } from './sprites';

/** 渲染所需的最小狀態切面 */
export interface RenderState {
  readonly ball: Vec3 | null;
  readonly playerA: Vec3;
  readonly playerB: Vec3;
  /** 這 tick 有人揮拍 → 觸發揮拍動畫 */
  readonly hitBy?: PlayerId | null;
  /** 這 tick 球撞牆 → 火花特效(引擎座標) */
  readonly wallHit?: { readonly wall: WallId; readonly point: Vec3 } | null;
}

export function renderStateOf(sim: GameSim, hitBy: PlayerId | null = null): RenderState {
  return {
    ball: sim.ball === null ? null : sim.ball.pos,
    playerA: sim.playerA.pos,
    playerB: sim.playerB.pos,
    hitBy,
  };
}

/** 引擎座標 → three 世界座標(前牆在 -D/2,鏡頭在後牆外) */
function toWorld(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(p.x - COURT_W / 2, p.z, p.y - COURT_D / 2);
}

/** 牆面 → 世界座標法線(火花面向) */
const WALL_NORMAL: Record<WallId, readonly [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [1, 0, 0],
  right: [-1, 0, 0],
  ceiling: [0, -1, 0],
};

/** Player3D 與 SpritePlayer 的共同介面(渲染層可切換) */
interface PlayerVisual {
  readonly group: THREE.Group;
  pose(x: number, z: number, faceX: number, faceZ: number): void;
  triggerSwing(): void;
  update(dt: number): void;
}

export class Render3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ball: THREE.Mesh;
  private readonly ballShadow: THREE.Mesh;
  private readonly playerA: PlayerVisual;
  private readonly playerB: PlayerVisual;
  private readonly crowd: Crowd;
  private readonly impacts: ImpactPool;
  private readonly tmp = new THREE.Vector3();
  private readonly tmpN = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3(0, 0.9, -COURT_D / 4);
  private lastTime: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090f);

    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 60);
    // 後牆外上方,看向前牆下段(轉播機位)
    this.camera.position.set(0, 4.2, COURT_D / 2 + 4.4);
    this.camera.lookAt(this.lookAt);

    this.scene.add(new THREE.HemisphereLight(0xf7efe0, 0x182036, 0.82));
    const key = new THREE.DirectionalLight(0xfff4d6, 1.65);
    key.position.set(3, 8, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce8ff, 0.7);
    fill.position.set(-4, 6, -6);
    this.scene.add(fill);
    const backGlow = new THREE.PointLight(0x77d7ff, 1.15, 12, 1.8);
    backGlow.position.set(0, 2.5, COURT_D / 2 + 0.2);
    this.scene.add(backGlow);

    this.scene.add(buildCourt());

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.35 }),
    );
    // 球的接地影:貼地圓片,越高越小越淡(高度感 + 落點預判)
    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.09, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.position.y = 0.004;
    this.scene.add(this.ballShadow);
    // P5 預設 sprite 像素球員;網址帶 ?c3d 退回程序化 3D 版(fallback)
    const useSprites = !window.location.search.includes('c3d');
    this.playerA = useSprites ? makeSpritePlayerA() : new Player3D(0x3b82f6);
    this.playerB = useSprites ? makeSpritePlayerB() : new Player3D(0xf97316);
    this.scene.add(this.ball, this.playerA.group, this.playerB.group);

    // 前牆上方觀眾席 + 擊牆火花池
    this.crowd = new Crowd(COURT_W, COURT_H + 0.08, -COURT_D / 2);
    this.impacts = new ImpactPool();
    this.scene.add(this.crowd.group, this.impacts.group);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  sync(state: RenderState): void {
    let faceX = 0;
    let faceZ = -COURT_D / 2; // 沒球時面向前牆
    if (state.ball === null) {
      this.ball.visible = false;
      this.ballShadow.visible = false;
    } else {
      this.ball.visible = true;
      toWorld(state.ball, this.tmp);
      this.ball.position.copy(this.tmp);
      faceX = this.tmp.x;
      faceZ = this.tmp.z;
      // 影子跟著球的地面投影;高度 0→3m 之間縮小變淡
      this.ballShadow.visible = true;
      this.ballShadow.position.set(this.tmp.x, 0.004, this.tmp.z);
      const h = Math.min(Math.max(this.tmp.y, 0), 3) / 3;
      const s = 1.2 - h * 0.7;
      this.ballShadow.scale.set(s, s, 1);
      (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - h * 0.75);
    }
    toWorld(state.playerA, this.tmp);
    this.playerA.pose(this.tmp.x, this.tmp.z, faceX, faceZ);
    toWorld(state.playerB, this.tmp);
    this.playerB.pose(this.tmp.x, this.tmp.z, faceX, faceZ);
    if (state.hitBy === 'A') this.playerA.triggerSwing();
    else if (state.hitBy === 'B') this.playerB.triggerSwing();
    if (state.wallHit) {
      toWorld(state.wallHit.point, this.tmp);
      const n = WALL_NORMAL[state.wallHit.wall];
      this.impacts.spawn(this.tmp, this.tmpN.set(n[0], n[1], n[2]));
    }
  }

  render(): void {
    const now = performance.now() / 1000;
    const dt = this.lastTime === null ? 1 / 60 : Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;
    this.playerA.update(dt);
    this.playerB.update(dt);
    this.crowd.update(dt);
    this.impacts.update(dt);
    if (this.playerA instanceof SpritePlayer) this.playerA.billboard(this.camera.position);
    if (this.playerB instanceof SpritePlayer) this.playerB.billboard(this.camera.position);
    // 鏡頭微追蹤球的橫向(緩慢 lerp,球不在就回中)
    const targetX = this.ball.visible ? this.ball.position.x * 0.28 : 0;
    this.camera.position.x += (targetX - this.camera.position.x) * 0.04;
    this.lookAt.x = this.camera.position.x * 0.6;
    this.camera.lookAt(this.lookAt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
