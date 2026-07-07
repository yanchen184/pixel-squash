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

export function buildCourt(): THREE.Group {
  const g = new THREE.Group();
  const W = COURT_W;
  const D = COURT_D;
  const H = COURT_H;

  // ---- 地板(楓木) ----
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0xc9a86b, roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);

  // ---- 前牆(不透明,含 tin) ----
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xf0ebdf,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  frontWall.position.set(0, H / 2, -D / 2);
  g.add(frontWall);

  // tin 面板(0 → 0.48m 深色帶)+ 上緣線
  const tin = new THREE.Mesh(
    new THREE.PlaneGeometry(W, TIN_HEIGHT),
    new THREE.MeshStandardMaterial({ color: 0x4a4f5a, roughness: 0.9 }),
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
      color: 0x9fd8e8,
      transparent: true,
      opacity: 0.1,
      roughness: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  glass.position.set(0, H / 2, D / 2);
  g.add(glass);
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

  return g;
}
