/**
 * P4 程序化低模球員:骨盆/軀幹/胸/肩/頭/雙腿/雙臂 + 握在手掌的球拍,零外部資產。
 * 目標「立體有型」:分段人體(有腰身收窄、肩膀變寬)、雙臂皆有上臂+前臂+手、
 * 球拍確實接在持拍手掌上。動畫全在渲染層(視覺插值,不回寫引擎):
 * 跑步擺腿擺臂、待機呼吸、揮拍弧線、面向球。
 */
import * as THREE from 'three';

const LEG_H = 0.5;
const LEG_R = 0.075;
const HIP_Y = LEG_H; // 骨盆高
const PELVIS_H = 0.16;
const TORSO_H = 0.34; // 腹部(收窄)
const CHEST_H = 0.26; // 胸(較寬)
const HEAD_R = 0.135;
const NECK_H = 0.06;

const SHOULDER_W = 0.24; // 肩半寬
const UPPER_ARM_L = 0.26;
const FOREARM_L = 0.24;
const ARM_R = 0.052;
const SHOULDER_Y = HIP_Y + PELVIS_H + TORSO_H + CHEST_H * 0.75;

export const SWING_TICKS = 18; // 揮拍動畫全長(0.3s)

function limbMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
}

const SKIN = 0xe8b48a;
function skinMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.75 });
}

/** 球拍:加大拍框 + 拍面 + 較粗握把,原點在握把底(接手掌處) */
function makeRacket(): THREE.Group {
  const g = new THREE.Group();
  const handleLen = 0.22;
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.024, handleLen, 10),
    new THREE.MeshStandardMaterial({ color: 0x22252c, roughness: 0.55 }),
  );
  handle.position.y = handleLen / 2;
  g.add(handle);
  // 拍頸
  const throat = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.024, 0.08, 8),
    new THREE.MeshStandardMaterial({ color: 0x30343d, roughness: 0.5 }),
  );
  throat.position.y = handleLen + 0.04;
  g.add(throat);
  // 拍框(橢圓,立在頸上)
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x1f6f8b,
    roughness: 0.35,
    metalness: 0.3,
  });
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 10, 28), frameMat);
  frame.position.y = handleLen + 0.04 + 0.15 + 0.02;
  g.add(frame);
  const strings = new THREE.Mesh(
    new THREE.CircleGeometry(0.145, 24),
    new THREE.MeshBasicMaterial({
      color: 0xf2f5fb,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    }),
  );
  strings.position.y = frame.position.y;
  strings.rotation.x = Math.PI / 2;
  g.add(strings);
  return g;
}

/** 建一條手臂(上臂 pivot → 前臂 pivot → 手),回傳肩 pivot 與可選的手 group */
interface Arm {
  readonly shoulder: THREE.Group; // 肩關節,繞此揮動
  readonly hand: THREE.Group; // 手掌處(可掛球拍)
}

function makeArm(mat: THREE.MeshStandardMaterial): Arm {
  const shoulder = new THREE.Group();
  const upper = new THREE.Mesh(
    new THREE.CapsuleGeometry(ARM_R, UPPER_ARM_L - ARM_R * 2, 4, 8),
    mat,
  );
  upper.position.y = -UPPER_ARM_L / 2;
  shoulder.add(upper);

  const elbow = new THREE.Group();
  elbow.position.y = -UPPER_ARM_L;
  shoulder.add(elbow);
  const fore = new THREE.Mesh(
    new THREE.CapsuleGeometry(ARM_R * 0.85, FOREARM_L - ARM_R * 2, 4, 8),
    skinMat(),
  );
  fore.position.y = -FOREARM_L / 2;
  elbow.add(fore);

  const hand = new THREE.Group();
  hand.position.y = -FOREARM_L;
  const palm = new THREE.Mesh(new THREE.SphereGeometry(ARM_R * 1.15, 8, 6), skinMat());
  hand.add(palm);
  elbow.add(hand);

  return { shoulder, hand };
}

/**
 * 可動球員。group 的原點在腳底;pose() 每幀餵位置/面向/移動量,
 * triggerSwing() 播一次揮拍,update(dt) 推進動畫時鐘。
 */
export class Player3D {
  readonly group: THREE.Group;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private readonly rightArm: Arm; // 持拍臂
  private readonly leftArm: Arm; // 平衡臂
  private readonly torso: THREE.Group; // 腰以上整體(呼吸/前傾)
  private clock = 0;
  private swingAt = -1e9; // 揮拍起始時刻(clock 秒)
  private runPhase = 0;
  private lastPos = new THREE.Vector2();
  private speed = 0; // 平滑後的移動速率(m/s)

  constructor(color: number) {
    this.group = new THREE.Group();
    const mat = limbMat(color);
    const darker = limbMat(new THREE.Color(color).multiplyScalar(0.55).getHex()); // 短褲深色

    // 雙腿(深色短褲色)
    this.legL = new THREE.Mesh(new THREE.CapsuleGeometry(LEG_R, LEG_H - LEG_R * 2, 4, 8), darker);
    this.legR = this.legL.clone();
    this.legL.position.set(-0.1, LEG_H / 2, 0);
    this.legR.position.set(0.1, LEG_H / 2, 0);
    this.group.add(this.legL, this.legR);

    // 腰以上放進 torso group(讓呼吸/前傾一起動)
    this.torso = new THREE.Group();
    this.torso.position.y = HIP_Y;
    this.group.add(this.torso);

    // 骨盆(深色)
    const pelvis = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, PELVIS_H, 4, 10),
      darker,
    );
    pelvis.scale.z = 0.7;
    pelvis.position.y = PELVIS_H / 2;
    this.torso.add(pelvis);

    // 腹部(收窄,球衣色)
    const belly = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.145, TORSO_H, 6, 12),
      mat,
    );
    belly.scale.set(1, 1, 0.72);
    belly.position.y = PELVIS_H + TORSO_H / 2;
    this.torso.add(belly);

    // 胸(較寬,球衣色)
    const chest = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.185, CHEST_H, 6, 12),
      mat,
    );
    chest.scale.set(1, 1, 0.66);
    chest.position.y = PELVIS_H + TORSO_H + CHEST_H / 2;
    this.torso.add(chest);

    // 肩線(橫向膠囊,讓肩膀有寬度)
    const shoulders = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.075, SHOULDER_W * 2, 4, 8),
      mat,
    );
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.y = SHOULDER_Y - HIP_Y;
    this.torso.add(shoulders);

    // 脖子 + 頭(膚色)
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, NECK_H, 8), skinMat());
    neck.position.y = SHOULDER_Y - HIP_Y + 0.05;
    this.torso.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 16, 12), skinMat());
    head.scale.set(0.92, 1.05, 0.92);
    head.position.y = SHOULDER_Y - HIP_Y + 0.05 + NECK_H + HEAD_R * 0.85;
    this.torso.add(head);
    // 頭髮(上半深色殼)
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R * 1.02, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
      new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.85 }),
    );
    hair.scale.copy(head.scale);
    hair.position.copy(head.position);
    hair.position.y += HEAD_R * 0.06;
    this.torso.add(hair);

    // 持拍臂(右)+ 球拍
    this.rightArm = makeArm(mat);
    this.rightArm.shoulder.position.set(SHOULDER_W, SHOULDER_Y - HIP_Y, 0);
    this.rightArm.shoulder.rotation.z = -0.28; // 待機略張
    this.torso.add(this.rightArm.shoulder);
    const racket = makeRacket();
    racket.rotation.x = -Math.PI / 2; // 拍子朝前伸
    this.rightArm.hand.add(racket);

    // 平衡臂(左)
    this.leftArm = makeArm(mat);
    this.leftArm.shoulder.position.set(-SHOULDER_W, SHOULDER_Y - HIP_Y, 0);
    this.leftArm.shoulder.rotation.z = 0.28;
    this.torso.add(this.leftArm.shoulder);
  }

  /** 每渲染幀餵目標位置(引擎 world 座標已轉 three)與面向點 */
  pose(x: number, z: number, faceX: number, faceZ: number): void {
    this.group.position.set(x, 0, z);
    const dx = faceX - x;
    const dz = faceZ - z;
    if (dx * dx + dz * dz > 1e-6) {
      const target = Math.atan2(dx, dz); // 模型 +Z 朝向面向點
      let d = target - this.group.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.group.rotation.y += d * 0.18; // 平滑轉身
    }
    const v = new THREE.Vector2(x, z);
    const dist = v.distanceTo(this.lastPos);
    this.lastPos.copy(v);
    this.speed = this.speed * 0.85 + dist * 60 * 0.15;
  }

  triggerSwing(): void {
    this.swingAt = this.clock;
  }

  /** 推進動畫(dt 秒,跟播放速度無關的視覺時鐘) */
  update(dt: number): void {
    this.clock += dt;
    const running = this.speed > 0.4;
    if (running) {
      this.runPhase += dt * (6 + this.speed * 2.4);
      const a = Math.sin(this.runPhase) * 0.55;
      this.legL.rotation.x = a;
      this.legR.rotation.x = -a;
      this.torso.rotation.x = 0.14;
      this.torso.position.y = HIP_Y;
      // 手臂反相擺動(持拍臂擺幅小,免得穿模)
      this.leftArm.shoulder.rotation.x = -a * 0.7;
      this.rightArm.shoulder.rotation.x = a * 0.35;
    } else {
      this.legL.rotation.x *= 0.8;
      this.legR.rotation.x *= 0.8;
      this.torso.rotation.x *= 0.8;
      this.torso.position.y = HIP_Y + Math.sin(this.clock * 1.8) * 0.01; // 呼吸
      this.leftArm.shoulder.rotation.x *= 0.85;
    }
    // 揮拍:後拉 → 加速揮出 → 收拍(繞肩 X 軸弧線 + Z 軸張角)
    const t = (this.clock - this.swingAt) / (SWING_TICKS / 60);
    if (t >= 0 && t <= 1) {
      const arc =
        t < 0.3
          ? -1.0 * (t / 0.3) // 後拉
          : t < 0.65
            ? -1.0 + 2.7 * ((t - 0.3) / 0.35) // 揮出
            : 1.7 * (1 - (t - 0.65) / 0.35); // 收拍
      this.rightArm.shoulder.rotation.x = arc;
      this.rightArm.shoulder.rotation.z = -0.28 - 0.55 * Math.sin(Math.PI * t);
    } else if (!running) {
      this.rightArm.shoulder.rotation.x *= 0.85;
      this.rightArm.shoulder.rotation.z = this.rightArm.shoulder.rotation.z * 0.85 + -0.28 * 0.15;
    }
  }
}
