/**
 * P5 sprite sheet 動畫層:codex 生成的 4×4(16 幀)像素圖,texture offset 逐幀輪播。
 * - SpritePlayer:billboard 球員,同 Player3D 介面(group/pose/triggerSwing/update),
 *   列 0=待機、1=跑步、2=正手揮拍、3=反手揮拍;依移動速度/揮拍事件切列。
 * - Crowd:前牆上方觀眾席,4 面板錯相輪播(避免整排同步複製感)。
 * - ImpactPool:擊牆火花,一次性 16 幀,加法混合(黑底圖)。
 * 全部只在渲染層,不碰確定性引擎。
 */
import * as THREE from 'three';

const COLS = 4;
const ROWS = 4;
const FRAMES = COLS * ROWS;

const sheetLoader = new THREE.TextureLoader();
function loadSheet(path: string): THREE.Texture {
  const t = sheetLoader.load(path);
  t.colorSpace = THREE.SRGBColorSpace;
  // 像素風:近取樣,不做 mipmap 模糊
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

const SHEET_BLUE = loadSheet('/textures/sprites/player-blue.png');
const SHEET_ORANGE = loadSheet('/textures/sprites/player-orange.png');
const SHEET_CROWD = loadSheet('/textures/sprites/crowd.png');
const SHEET_IMPACT = loadSheet('/textures/sprites/impact.png');

/** 每個使用者各 clone 一份 texture,才能各自控制 offset(底圖 GPU 上仍共享) */
function flipbookTex(base: THREE.Texture): THREE.Texture {
  const t = base.clone();
  t.repeat.set(1 / COLS, 1 / ROWS);
  return t;
}

/** 幀 i(0..15,左上起橫向讀)→ texture offset */
function setFrame(t: THREE.Texture, i: number): void {
  const f = ((i % FRAMES) + FRAMES) % FRAMES;
  const col = f % COLS;
  const row = (f - col) / COLS;
  t.offset.set(col / COLS, 1 - (row + 1) / ROWS);
}

// 與 Player3D 對齊的動畫參數
const SWING_SEC = 0.3;
const RUN_SPEED_MIN = 0.4;
const SPRITE_H = 1.9; // 帶留邊的格子 → 角色實高約 1.6m

export class SpritePlayer {
  readonly group: THREE.Group;
  private readonly mesh: THREE.Mesh;
  private readonly tex: THREE.Texture;
  private clock = 0;
  private swingAt = -1e9;
  private swingRow = 2; // 2=正手 3=反手
  private ballSide = 1; // 球在右(+)/左(-),決定正反手
  private runPhase = 0;
  private readonly lastPos = new THREE.Vector2();
  private speed = 0;
  private moveX = 0; // 橫向速度(平滑),決定跑步幀左右鏡像
  private facing = 1; // 1=原圖(朝右跑) -1=鏡像(朝左跑)

  constructor(sheet: THREE.Texture) {
    this.group = new THREE.Group();
    this.tex = flipbookTex(sheet);
    setFrame(this.tex, 0);
    const geo = new THREE.PlaneGeometry(SPRITE_H, SPRITE_H);
    geo.translate(0, SPRITE_H / 2, 0); // 原點在腳底,與 Player3D 一致
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: this.tex,
        transparent: true,
        alphaTest: 0.5, // 像素硬邊,免透明排序問題
        side: THREE.DoubleSide,
      }),
    );
    this.group.add(this.mesh);
    // 接地陰影(billboard 少了立體感,靠影子把腳釘在地上)
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.34, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    this.group.add(shadow);
  }

  /** 同 Player3D 介面:餵位置與面向點(此處面向點=球,用來選正/反手) */
  pose(x: number, z: number, faceX: number, _faceZ: number): void {
    this.group.position.set(x, 0, z);
    this.ballSide = faceX - x >= 0 ? 1 : -1;
    const dx = x - this.lastPos.x;
    const dist = Math.hypot(dx, z - this.lastPos.y);
    this.lastPos.set(x, z);
    this.speed = this.speed * 0.85 + dist * 60 * 0.15;
    this.moveX = this.moveX * 0.85 + dx * 60 * 0.15;
  }

  triggerSwing(): void {
    this.swingAt = this.clock;
    this.swingRow = this.ballSide >= 0 ? 2 : 3;
  }

  /** 圓柱 billboard:只繞 Y 面向鏡頭(sprite 是背側視角,鏡頭在球員後方) */
  billboard(camPos: THREE.Vector3): void {
    this.mesh.rotation.y = Math.atan2(
      camPos.x - this.group.position.x,
      camPos.z - this.group.position.z,
    );
  }

  update(dt: number): void {
    this.clock += dt;
    const swingT = (this.clock - this.swingAt) / SWING_SEC;
    if (swingT >= 0 && swingT <= 1) {
      // 揮拍:0.3 秒內播完該列 4 幀(正反手已依球側選列,不鏡像)
      this.mesh.scale.x = 1;
      setFrame(this.tex, this.swingRow * COLS + Math.min(COLS - 1, Math.floor(swingT * COLS)));
      return;
    }
    if (this.speed > RUN_SPEED_MIN) {
      // 原圖跑步幀朝右;往左移就水平鏡像,沒有明確橫向時沿用上次朝向
      if (this.moveX > 0.25) this.facing = 1;
      else if (this.moveX < -0.25) this.facing = -1;
      this.mesh.scale.x = this.facing;
      this.runPhase += dt * (8 + this.speed * 2.5); // 跑越快步頻越高
      setFrame(this.tex, COLS + Math.floor(this.runPhase) % COLS);
    } else {
      this.mesh.scale.x = 1;
      setFrame(this.tex, Math.floor(this.clock * 5) % COLS); // 待機呼吸 5fps
    }
  }
}

export function makeSpritePlayerA(): SpritePlayer {
  return new SpritePlayer(SHEET_BLUE);
}
export function makeSpritePlayerB(): SpritePlayer {
  return new SpritePlayer(SHEET_ORANGE);
}

/** 前牆上方觀眾席:panels 塊面板,各自錯開起始幀,~5fps 輪播 */
export class Crowd {
  readonly group = new THREE.Group();
  private readonly texes: THREE.Texture[] = [];
  private clock = 0;

  constructor(width: number, wallTopY: number, wallZ: number, panels = 4) {
    const w = width / panels;
    for (let i = 0; i < panels; i++) {
      const tex = flipbookTex(SHEET_CROWD);
      setFrame(tex, (i * 5) % FRAMES);
      this.texes.push(tex);
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(w, w * 0.75), // 觀眾列取格子比例,略壓扁塞牆頂
        new THREE.MeshBasicMaterial({ map: tex }),
      );
      panel.position.set(-width / 2 + w * (i + 0.5), wallTopY + (w * 0.75) / 2, wallZ);
      this.group.add(panel);
    }
  }

  update(dt: number): void {
    this.clock += dt;
    const base = Math.floor(this.clock * 5);
    this.texes.forEach((t, i) => setFrame(t, (base + i * 5) % FRAMES));
  }
}

/** 擊牆火花池:黑底圖加法混合,spawn 後 0.4 秒播完 16 幀自動隱藏 */
const IMPACT_SEC = 0.4;
const IMPACT_SIZE = 0.9;

interface Burst {
  readonly mesh: THREE.Mesh;
  readonly tex: THREE.Texture;
  startedAt: number;
}

export class ImpactPool {
  readonly group = new THREE.Group();
  private readonly bursts: Burst[] = [];
  private clock = 0;
  private next = 0;

  constructor(size = 3) {
    for (let i = 0; i < size; i++) {
      const tex = flipbookTex(SHEET_IMPACT);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(IMPACT_SIZE, IMPACT_SIZE),
        new THREE.MeshBasicMaterial({
          map: tex,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.visible = false;
      this.group.add(mesh);
      this.bursts.push({ mesh, tex, startedAt: -1e9 });
    }
  }

  /** 在世界座標 pos 播一發,面向 normal(牆面法線) */
  spawn(pos: THREE.Vector3, normal: THREE.Vector3): void {
    const b = this.bursts[this.next];
    this.next = (this.next + 1) % this.bursts.length;
    b.mesh.position.copy(pos).addScaledVector(normal, 0.03);
    b.mesh.lookAt(pos.clone().add(normal));
    b.mesh.visible = true;
    b.startedAt = this.clock;
  }

  update(dt: number): void {
    this.clock += dt;
    for (const b of this.bursts) {
      if (!b.mesh.visible) continue;
      const t = (this.clock - b.startedAt) / IMPACT_SEC;
      if (t >= 1) {
        b.mesh.visible = false;
        continue;
      }
      setFrame(b.tex, Math.min(FRAMES - 1, Math.floor(t * FRAMES)));
    }
  }
}
