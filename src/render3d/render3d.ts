/**
 * P3/P4 3D 渲染器:只讀引擎狀態(RenderState),不寫回 —— 渲染層永遠是引擎的旁觀者。
 * 重播檢視器與正式遊戲共用同一個 Render3D;差別只在 RenderState 從哪來
 * (重播 = 預錄 frames,遊戲 = 每 tick 的 GameSim)。
 * P4:程序化球員(player3d)+ 揮拍動畫 + 鏡頭微追蹤球。
 */
import * as THREE from 'three';
import type { Vec3 } from '../engine/ball';
import { COURT_D, COURT_W } from '../engine/ball';
import type { PlayerId } from '../engine/rules';
import type { GameSim } from '../engine/sim';
import { buildCourt } from './court3d';
import { Player3D } from './player3d';

/** 渲染所需的最小狀態切面 */
export interface RenderState {
  readonly ball: Vec3 | null;
  readonly playerA: Vec3;
  readonly playerB: Vec3;
  /** 這 tick 有人揮拍 → 觸發揮拍動畫 */
  readonly hitBy?: PlayerId | null;
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

export class Render3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ball: THREE.Mesh;
  private readonly playerA: Player3D;
  private readonly playerB: Player3D;
  private readonly tmp = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3(0, 0.9, -COURT_D / 4);
  private lastTime: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141f);

    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 60);
    // 後牆外上方,看向前牆下段(轉播機位)
    this.camera.position.set(0, 4.2, COURT_D / 2 + 4.4);
    this.camera.lookAt(this.lookAt);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xfff4e0, 1.4);
    key.position.set(3, 8, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce8ff, 0.5);
    fill.position.set(-4, 6, -6);
    this.scene.add(fill);

    this.scene.add(buildCourt());

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.35 }),
    );
    this.playerA = new Player3D(0x3b82f6);
    this.playerB = new Player3D(0xf97316);
    this.scene.add(this.ball, this.playerA.group, this.playerB.group);
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
    } else {
      this.ball.visible = true;
      toWorld(state.ball, this.tmp);
      this.ball.position.copy(this.tmp);
      faceX = this.tmp.x;
      faceZ = this.tmp.z;
    }
    toWorld(state.playerA, this.tmp);
    this.playerA.pose(this.tmp.x, this.tmp.z, faceX, faceZ);
    toWorld(state.playerB, this.tmp);
    this.playerB.pose(this.tmp.x, this.tmp.z, faceX, faceZ);
    if (state.hitBy === 'A') this.playerA.triggerSwing();
    else if (state.hitBy === 'B') this.playerB.triggerSwing();
  }

  render(): void {
    const now = performance.now() / 1000;
    const dt = this.lastTime === null ? 1 / 60 : Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;
    this.playerA.update(dt);
    this.playerB.update(dt);
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
