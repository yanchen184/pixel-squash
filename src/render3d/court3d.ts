/**
 * P3 真 3D 球場(靜態幾何)。單位 = 引擎 SI(公尺),尺寸/線高全部 import 引擎常數,
 * 不自己抄數字 —— 引擎改,場就跟著改。
 *
 * 座標映射(見 render3d.ts toWorld):引擎 x(橫)→ world.x(置中)、
 * z(高)→ world.y、y(離前牆縱深)→ world.z(前牆在 -D/2,鏡頭在後牆外)。
 */
import * as THREE from 'three';
import { COURT_D, COURT_H, COURT_W } from '../engine/ball';
import {
  BACK_OUT_LINE,
  FRONT_OUT_LINE,
  SERVICE_LINE,
  SHORT_LINE_Y,
  TIN_HEIGHT,
} from '../engine/rules';

const LINE_W = 0.05; // 場地線寬(真實壁球線 5cm)
const EPS = 0.006; // 線浮出牆/地面,避免 z-fighting

const LINE_MAT = new THREE.MeshBasicMaterial({ color: 0xd23c3c });
const FLOOR_LINE_MAT = new THREE.MeshBasicMaterial({ color: 0xb03030 });

/** 貼在牆/地上的細長線(盒體,比 1px Line 看得清楚) */
function lineBox(w: number, h: number, d: number, mat = LINE_MAT): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

function canvasTexture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');
  paint(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeMapleFloorTexture(): THREE.Texture {
  const tex = canvasTexture(1024, 1024, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 1024, 1024);
    g.addColorStop(0, '#d5a05d');
    g.addColorStop(0.42, '#c18442');
    g.addColorStop(1, '#8e582d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);
    for (let y = 0; y < 1024; y += 64) {
      ctx.fillStyle = y % 128 === 0 ? 'rgba(255,230,170,0.07)' : 'rgba(70,35,12,0.08)';
      ctx.fillRect(0, y, 1024, 2);
      for (let x = (y / 64) % 2 === 0 ? 0 : 140; x < 1024; x += 280) {
        ctx.fillStyle = 'rgba(80,38,12,0.13)';
        ctx.fillRect(x, y, 2, 64);
      }
    }
    for (let i = 0; i < 180; i++) {
      const y = (i * 37) % 1024;
      const x = (i * 91) % 1024;
      const len = 80 + (i % 7) * 24;
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,235,180,0.08)' : 'rgba(72,32,8,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + len * 0.3, y - 10, x + len * 0.7, y + 11, x + len, y);
      ctx.stroke();
    }
  });
  tex.repeat.set(2.4, 4.2);
  return tex;
}

function makeWallTexture(): THREE.Texture {
  const tex = canvasTexture(1024, 1024, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0, '#f3efe3');
    g.addColorStop(0.58, '#ded8c8');
    g.addColorStop(1, '#c5bdab');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.strokeStyle = 'rgba(70,75,70,0.10)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= 1024; x += 256) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 1024);
      ctx.stroke();
    }
    for (let y = 192; y < 1024; y += 192) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1024, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(0, 0, 1024, 80);
  });
  tex.repeat.set(1.8, 1);
  return tex;
}

export function buildCourt(): THREE.Group {
  const g = new THREE.Group();
  const W = COURT_W;
  const D = COURT_D;
  const H = COURT_H;
  const floorTex = makeMapleFloorTexture();
  const wallTex = makeWallTexture();

  // ---- 地板(楓木) ----
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({
      map: floorTex,
      color: 0xfff0d0,
      roughness: 0.48,
      metalness: 0.02,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);

  // ---- 前牆(不透明,含 tin) ----
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex,
    color: 0xffffff,
    roughness: 0.74,
    side: THREE.DoubleSide,
  });
  const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  frontWall.position.set(0, H / 2, -D / 2);
  g.add(frontWall);

  // tin 面板(0 → 0.48m 深色帶)+ 上緣線
  const tin = new THREE.Mesh(
    new THREE.PlaneGeometry(W, TIN_HEIGHT),
    new THREE.MeshStandardMaterial({ color: 0x2d3036, roughness: 0.82, metalness: 0.08 }),
  );
  tin.position.set(0, TIN_HEIGHT / 2, -D / 2 + EPS);
  g.add(tin);
  for (const z of [TIN_HEIGHT, SERVICE_LINE, FRONT_OUT_LINE]) {
    const l = lineBox(W, LINE_W, 0.01);
    l.position.set(0, z, -D / 2 + EPS);
    g.add(l);
  }

  // ---- 側牆(米白,不透明;鏡頭沿場軸看,不會擋) ----
  for (const sideX of [-W / 2, W / 2]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
    wall.rotation.y = sideX < 0 ? Math.PI / 2 : -Math.PI / 2;
    wall.position.set(sideX, H / 2, 0);
    g.add(wall);

    // 斜界外線:前 4.57 → 後 2.13 線性斜降
    const rise = FRONT_OUT_LINE - BACK_OUT_LINE;
    const len = Math.sqrt(D * D + rise * rise);
    const slope = lineBox(len, LINE_W, 0.01);
    slope.rotation.y = sideX < 0 ? Math.PI / 2 : -Math.PI / 2;
    // 沿牆面傾斜(牆面座標的 roll)
    slope.rotation.z = (sideX < 0 ? 1 : -1) * Math.atan2(rise, D);
    const inward = sideX < 0 ? EPS : -EPS;
    slope.position.set(sideX + inward, (FRONT_OUT_LINE + BACK_OUT_LINE) / 2, 0);
    g.add(slope);
  }

  // ---- 後牆(玻璃,鏡頭透過它看場內) ----
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({
      color: 0xb9e8f6,
      transparent: true,
      opacity: 0.18,
      roughness: 0.04,
      metalness: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  glass.position.set(0, H / 2, D / 2);
  g.add(glass);
  const glassGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({
      color: 0x9fd8e8,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  glassGlow.position.set(0, H / 2, D / 2 - EPS * 2);
  g.add(glassGlow);
  const backLine = lineBox(W, LINE_W, 0.01);
  backLine.position.set(0, BACK_OUT_LINE, D / 2 - EPS);
  g.add(backLine);

  // ---- 地板線(short line / 半場線 / 發球格) ----
  const shortZ = SHORT_LINE_Y - D / 2; // 引擎 y=5.44 → world z
  const shortLine = lineBox(W, 0.01, LINE_W, FLOOR_LINE_MAT);
  shortLine.position.set(0, EPS, shortZ);
  g.add(shortLine);

  const halfLen = D / 2 - shortZ; // short line → 後牆
  const halfLine = lineBox(LINE_W, 0.01, halfLen, FLOOR_LINE_MAT);
  halfLine.position.set(0, EPS, shortZ + halfLen / 2);
  g.add(halfLine);

  // 發球格:1.6m 正方形,貼側牆、前緣在 short line 上
  const BOX = 1.6;
  for (const sideX of [-W / 2, W / 2]) {
    const inner = sideX < 0 ? sideX + BOX : sideX - BOX;
    const cx = (sideX + inner) / 2;
    const back = lineBox(BOX, 0.01, LINE_W, FLOOR_LINE_MAT);
    back.position.set(cx, EPS, shortZ + BOX);
    g.add(back);
    const side = lineBox(LINE_W, 0.01, BOX, FLOOR_LINE_MAT);
    side.position.set(inner, EPS, shortZ + BOX / 2);
    g.add(side);
  }

  // ---- 場館頂光:暖白燈條投到木地板,讓材質不只靠貼圖撐 ----
  const lightMat = new THREE.MeshBasicMaterial({
    color: 0xfff0c0,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });
  for (const z of [-D * 0.28, 0, D * 0.28]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.42, 0.08), lightMat);
    panel.rotation.x = Math.PI / 2;
    panel.position.set(0, H + 0.06, z);
    g.add(panel);
  }

  return g;
}
