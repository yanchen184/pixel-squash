/**
 * P3 3D 渲染器:只讀引擎狀態(RenderState),不寫回 —— 渲染層永遠是引擎的旁觀者。
 * 重播檢視器與正式遊戲共用同一個 Render3D;差別只在 RenderState 從哪來
 * (重播 = 預錄 frames,遊戲 = 每 tick 的 GameSim)。
 */
import * as THREE from 'three';
import type { Vec3 } from '../engine/ball';
import { COURT_D, COURT_W } from '../engine/ball';
import type { GameSim } from '../engine/sim';
import { buildCourt } from './court3d';

/** 渲染所需的最小狀態切面 */
export interface RenderState {
  readonly ball: Vec3 | null;
  readonly playerA: Vec3;
  readonly playerB: Vec3;
}

export function renderStateOf(sim: GameSim): RenderState {
  return {
    ball: sim.ball === null ? null : sim.ball.pos,
    playerA: sim.playerA.pos,
    playerB: sim.playerB.pos,
  };
}

/** 引擎座標 → three 世界座標(前牆在 -D/2,鏡頭在後牆外) */
function toWorld(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(p.x - COURT_W / 2, p.z, p.y - COURT_D / 2);
}

const CAPSULE_R = 0.22;
const CAPSULE_LEN = 1.05;
const CAPSULE_CY = CAPSULE_R + CAPSULE_LEN / 2; // 腳貼地時膠囊中心高

function makePlayer(color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(CAPSULE_R, CAPSULE_LEN, 6, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  return mesh;
}

export class Render3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ball: THREE.Mesh;
  private readonly playerA: THREE.Mesh;
  private readonly playerB: THREE.Mesh;
  private readonly tmp = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141f);

    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 60);
    // 後牆外上方,看向前牆下段(轉播機位)
    this.camera.position.set(0, 4.2, COURT_D / 2 + 4.4);
    this.camera.lookAt(0, 0.9, -COURT_D / 4);

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
    this.playerA = makePlayer(0x3b82f6);
    this.playerB = makePlayer(0xf97316);
    this.scene.add(this.ball, this.playerA, this.playerB);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  sync(state: RenderState): void {
    if (state.ball === null) {
      this.ball.visible = false;
    } else {
      this.ball.visible = true;
      toWorld(state.ball, this.tmp);
      this.ball.position.copy(this.tmp);
    }
    toWorld(state.playerA, this.tmp);
    this.playerA.position.set(this.tmp.x, CAPSULE_CY, this.tmp.z);
    toWorld(state.playerB, this.tmp);
    this.playerB.position.set(this.tmp.x, CAPSULE_CY, this.tmp.z);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
