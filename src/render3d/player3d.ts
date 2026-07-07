/**
 * P4 程序化低模球員:軀幹/頭/雙腿/持拍手臂 + 球拍,零外部資產。
 * 動畫全在渲染層(視覺插值,不回寫引擎):跑步擺腿、待機呼吸、揮拍弧線、面向球。
 */
import * as THREE from 'three';

const TORSO_H = 0.62;
const TORSO_R = 0.17;
const LEG_H = 0.5;
const LEG_R = 0.07;
const HEAD_R = 0.13;
const ARM_L = 0.42;
const ARM_R = 0.05;
const HIP_Y = LEG_H; // 骨盆高
const SHOULDER_Y = HIP_Y + TORSO_H * 0.78;

export const SWING_TICKS = 18; // 揮拍動畫全長(0.3s)

function limbMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
}

function makeRacket(): THREE.Group {
  const g = new THREE.Group();
  const handleLen = 0.3;
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, handleLen, 8),
    new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.5 }),
  );
  handle.position.y = -handleLen / 2;
  g.add(handle);
  const head = new THREE.Mesh(
    new THREE.TorusGeometry(0.13, 0.014, 8, 20),
    new THREE.MeshStandardMaterial({ color: 0xd8dde8, roughness: 0.35 }),
  );
  head.position.y = 0.13;
  g.add(head);
  const strings = new THREE.Mesh(
    new THREE.CircleGeometry(0.125, 20),
    new THREE.MeshBasicMaterial({
      color: 0xf5f7fb,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    }),
  );
  strings.position.y = 0.13;
  g.add(strings);
  return g;
}

/**
 * 可動球員。group 的原點在腳底;pose() 每幀餵位置/面向/移動量,
 * triggerSwing() 播一次揮拍,update(dt) 推進動畫時鐘。
 */
export class Player3D {
  readonly group: THREE.Group;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private readonly armPivot: THREE.Group; // 肩關節(揮拍旋轉軸)
  private readonly torso: THREE.Mesh;
  private clock = 0;
  private swingAt = -1e9; // 揮拍起始時刻(clock 秒)
  private runPhase = 0;
  private lastPos = new THREE.Vector2();
  private speed = 0; // 平滑後的移動速率(m/s)

  constructor(color: number) {
    this.group = new THREE.Group();
    const mat = limbMat(color);

    this.legL = new THREE.Mesh(new THREE.CapsuleGeometry(LEG_R, LEG_H - LEG_R * 2, 4, 8), mat);
    this.legR = this.legL.clone();
    this.legL.position.set(-0.09, LEG_H / 2, 0);
    this.legR.position.set(0.09, LEG_H / 2, 0);
    this.group.add(this.legL, this.legR);

    this.torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(TORSO_R, TORSO_H - TORSO_R * 2, 4, 12),
      mat,
    );
    this.torso.position.y = HIP_Y + TORSO_H / 2;
    this.group.add(this.torso);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.7 }),
    );
    head.position.y = HIP_Y + TORSO_H + HEAD_R + 0.03;
    this.group.add(head);

    // 持拍手臂:肩膀 pivot,前臂沿 -Y 伸出,拍子接在末端
    this.armPivot = new THREE.Group();
    this.armPivot.position.set(TORSO_R + 0.02, SHOULDER_Y, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(ARM_R, ARM_L - ARM_R * 2, 4, 8), mat);
    arm.position.y = -ARM_L / 2;
    this.armPivot.add(arm);
    const racket = makeRacket();
    racket.position.y = -ARM_L;
    racket.rotation.x = Math.PI / 2; // 拍面立起
    this.armPivot.add(racket);
    this.armPivot.rotation.z = -0.35; // 待機:手臂略張
    this.group.add(this.armPivot);
  }

  /** 每渲染幀餵目標位置(引擎 world 座標已轉 three)與面向點 */
  pose(x: number, z: number, faceX: number, faceZ: number): void {
    this.group.position.set(x, 0, z);
    const dx = faceX - x;
    const dz = faceZ - z;
    if (dx * dx + dz * dz > 1e-6) {
      // 目標 yaw:模型 +Z 朝向面向點
      const target = Math.atan2(dx, dz);
      let d = target - this.group.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.group.rotation.y += d * 0.18; // 平滑轉身
    }
    // 移動速率(給跑步動畫)
    const v = new THREE.Vector2(x, z);
    const dist = v.distanceTo(this.lastPos);
    this.lastPos.copy(v);
    this.speed = this.speed * 0.85 + (dist * 60) * 0.15;
  }

  triggerSwing(): void {
    this.swingAt = this.clock;
  }

  /** 推進動畫(dt 秒,跟播放速度無關的視覺時鐘) */
  update(dt: number): void {
    this.clock += dt;
    // 跑步擺腿(速率驅動);站定時歸位 + 呼吸
    const running = this.speed > 0.4;
    if (running) {
      this.runPhase += dt * (6 + this.speed * 2.4);
      const a = Math.sin(this.runPhase) * 0.55;
      this.legL.rotation.x = a;
      this.legR.rotation.x = -a;
      this.torso.rotation.x = 0.12;
    } else {
      this.legL.rotation.x *= 0.8;
      this.legR.rotation.x *= 0.8;
      this.torso.rotation.x *= 0.8;
      this.torso.position.y = HIP_Y + TORSO_H / 2 + Math.sin(this.clock * 1.8) * 0.008;
    }
    // 揮拍:後拉 → 加速揮出 → 收拍(繞肩 X 軸弧線 + Z 軸張角)
    const t = (this.clock - this.swingAt) / (SWING_TICKS / 60);
    if (t >= 0 && t <= 1) {
      const arc =
        t < 0.3
          ? -0.9 * (t / 0.3) // 後拉
          : t < 0.65
            ? -0.9 + 2.4 * ((t - 0.3) / 0.35) // 揮出
            : 1.5 * (1 - (t - 0.65) / 0.35); // 收拍
      this.armPivot.rotation.x = arc;
      this.armPivot.rotation.z = -0.35 - 0.5 * Math.sin(Math.PI * t);
    } else {
      this.armPivot.rotation.x *= 0.85;
      this.armPivot.rotation.z = this.armPivot.rotation.z * 0.85 + -0.35 * 0.15;
    }
  }
}
