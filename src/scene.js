// The apartment: geometry, materials, sunrise lighting and the view outside.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// One home in three segments, read off the sketch (top of the page = the TV wall):
//   left of the page  : living room, dining corner and kitchen (entrance at the bottom)
//   top right         : bedroom with a loft bed over a desk
//   bottom right      : bathroom
// The plan is scaled so the bed is 2.0 m long, which makes the home 8.4 m x 6.0 m.
// Positions are written as fractions of the plan, U(across) and V(down the page).
// Compass: the wall with the TV, at the top of the page, faces east. So -z is east,
// +x is south (the bathroom side), +z is west (the front door) and -x is north (the kitchen).
const W = 8.4, D = 6.0, H = 2.7;
const U = u => -W / 2 + u * W;          // plan fraction across -> world x
const V = v => -D / 2 + v * D;          // plan fraction down  -> world z
const PX = U(0.632), PZ = V(0.667);     // the two partitions: bedroom/bath from living, bath from bedroom
const T = 0.12;                         // partition thickness
const DOOR_H = 2.1;
const Y0 = 0.75, Y1 = 2.15;             // sill and head height of both windows

// The sun moves: buildScene().setSun(minutes) places it. Sunrise is minute 0.
// It climbs the way it does at Tuscany's latitude: about 0.18 degrees a minute
// upwards while sliding 0.17 degrees a minute to the south.
const sunDir = new THREE.Vector3(1, 0, 0);
export const SUNRISE = { start: -1, end: 45 };   // minutes covered by the animation

export const views = {
  overview: [[0.4, 9.4, 8.4], [0.3, 0, 0.3]],
  living:   [[0.55, 1.55, 2.5], [-2.5, 0.7, -1.4]],
  bedroom:  [[1.5, 1.55, 0.75], [4.0, 1.15, -1.9]],
  plan:     [[0, 10.5, 0.001], [0, 0, 0]],
};

export function buildScene(scene, renderer) {
  const hideFromAO = [];

  // ---------- helpers ----------
  let seed = 7;
  const rand = () => { // small deterministic generator so the room looks the same on every load
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  // Materials are shared wherever colour, texture and options match, which lets
  // the final merge step fold many small meshes into a single draw call.
  const matCache = new Map();
  const mat = (color, map, extra) => {
    const key = `${color}|${map ? map.uuid : ''}|${extra ? JSON.stringify(extra) : ''}`;
    if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...(map && { map }), ...extra }));
    return matCache.get(key);
  };

  function add(geo, material, x, y, z, parent = scene) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  // Boxes get softly rounded edges so they catch a highlight instead of looking razor-cut.
  const box = (w, h, d, material, x, y, z, parent) => {
    const m = Math.min(w, h, d);
    const geo = m >= 0.02 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(0.012, m * 0.25)) : new THREE.BoxGeometry(w, h, d);
    return add(geo, material, x, y, z, parent);
  };
  const ball = (r, material, x, y, z, parent, sx = 1, sy = 1, sz = 1) => {
    const m = add(new THREE.SphereGeometry(r, 28, 18), material, x, y, z, parent);
    m.scale.set(sx, sy, sz);
    return m;
  };
  const cyl = (rTop, rBottom, h, material, x, y, z, parent) =>
    add(new THREE.CylinderGeometry(rTop, rBottom, h, 28), material, x, y, z, parent);
  const group = (x, y, z, rotY = 0, parent = scene) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    parent.add(g);
    return g;
  };
  // A flat picture that hangs on a wall and, like the wall, is only visible from inside.
  const flat = (w, h, material, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  // Many copies of one small shape in a single draw call.
  function scatter(geo, material, matrices, parent) {
    const im = new THREE.InstancedMesh(geo, material, matrices.length);
    matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = im.receiveShadow = true;
    parent.add(im);
    return im;
  }

  // Rounded-corner slab lying flat; (x, y, z) is the centre of its underside.
  // mats = [top/bottom material, side material]
  function slab(w, h, d, r, mats, x, y, z, parent) {
    const s = new THREE.Shape(), a = -w / 2, b = -d / 2;
    s.moveTo(a + r, b); s.lineTo(a + w - r, b); s.quadraticCurveTo(a + w, b, a + w, b + r);
    s.lineTo(a + w, b + d - r); s.quadraticCurveTo(a + w, b + d, a + w - r, b + d);
    s.lineTo(a + r, b + d); s.quadraticCurveTo(a, b + d, a, b + d - r);
    s.lineTo(a, b + r); s.quadraticCurveTo(a, b, a + r, b);
    const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 12 });
    geo.rotateX(-Math.PI / 2);
    return add(geo, mats, x, y, z, parent);
  }

  // A pillow: pinched to nothing along its seam, plump in the middle, corners that stick out a little.
  function pillowGeo(w, d, t, n = 28) {
    const pos = [], uv = [], idx = [];
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const u = -1 + 2 * i / n, v = -1 + 2 * j / n;
        const plump = Math.pow(Math.max(0, (1 - u * u) * (1 - v * v)), 0.3);
        const crease = 0.004 * Math.sin(u * 9 + v * 3) * Math.sin(v * 7 - u * 2);
        pos.push(u * w / 2 * (1 - 0.07 * (1 - v * v)), side * (t / 2) * plump * (1 + crease / t * 1.5), v * d / 2 * (1 - 0.07 * (1 - u * u)));
        uv.push((u + 1) / 2, (v + 1) / 2);
      }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i, b = a + 1, c = a + n + 1, e = c + 1;
        side > 0 ? idx.push(a, c, b, b, c, e) : idx.push(a, b, c, b, e, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Fluff. Soft things get a coat of fine fibres drawn as stacked shells: each
  // shell is the surface pushed out a little further, and the shader keeps only
  // the dots where a fibre is still that long. One draw call per material.
  const furCache = new Map();
  function furMaterial(base, curl, shade) {
    const key = base.uuid + '|' + curl + '|' + shade;
    if (furCache.has(key)) return furCache.get(key);
    const m = new THREE.MeshStandardMaterial({ color: base.color, roughness: 1, alphaTest: 0.5, alphaToCoverage: true, ...(base.map && { map: base.map }) });
    m.onBeforeCompile = sh => {
      sh.uniforms.uCurl = { value: curl };
      sh.uniforms.uShade = { value: shade };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aShell;\nattribute vec2 furUv;\nvarying float vShell;\nvarying vec2 vFurUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShell = aShell;\nvFurUv = furUv;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vShell; varying vec2 vFurUv; uniform float uCurl, uShade;
          float furHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <alphatest_fragment>', `
          vec2 fu = vFurUv + uCurl * vShell * vec2(sin(vFurUv.y * 1.7), cos(vFurUv.x * 1.7));   // curl the fibre as it grows
          vec2 cell = floor(fu);
          float len = 0.35 + 0.65 * furHash(cell);                                              // each fibre its own length
          vec2 root = (vec2(furHash(cell + 7.3), furHash(cell + 19.1)) - 0.5) * 0.4;
          float r = length(fract(fu) - 0.5 - root) * 2.0;
          diffuseColor.a = (1.0 - vShell / len) - r * 0.9 + 0.5;                                // tapers to a tip
          diffuseColor.rgb *= mix(uShade, 1.06, vShell);                                           // darker down in the pile
          #include <alphatest_fragment>`);
    };
    m.customProgramCacheKey = () => 'fur';
    furCache.set(key, m);
    return m;
  }
  // uvSize = [metres per unit of u, metres per unit of v]; guessed from the bounding box when omitted.
  function fluff(meshes, { length, layers, strand, curl = 0, droop = 0.25, shade = 0.5, uvSize }) {
    const byMat = new Map();
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const src = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
      src.computeBoundingBox();
      const size = src.boundingBox.getSize(new THREE.Vector3());
      const us = (uvSize ? uvSize[0] : Math.PI * Math.max(size.x, size.z)) / strand;
      const vs = (uvSize ? uvSize[1] : Math.PI / 2 * Math.max(size.y, Math.min(size.x, size.z))) / strand;
      const P = src.attributes.position, N = src.attributes.normal, UV = src.attributes.uv, n = P.count;
      if (!byMat.has(mesh.material)) byMat.set(mesh.material, []);
      for (let i = 1; i <= layers; i++) {
        const t = i / layers, out = length * t, sag = droop * length * t * t;
        const pos = new Float32Array(n * 3), fu = new Float32Array(n * 2);
        for (let k = 0; k < n; k++) {
          pos[3 * k] = P.getX(k) + N.getX(k) * out;
          pos[3 * k + 1] = P.getY(k) + N.getY(k) * out - sag;
          pos[3 * k + 2] = P.getZ(k) + N.getZ(k) * out;
          fu[2 * k] = UV.getX(k) * us; fu[2 * k + 1] = UV.getY(k) * vs;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', N.clone());
        g.setAttribute('uv', UV.clone());
        g.setAttribute('furUv', new THREE.BufferAttribute(fu, 2));
        g.setAttribute('aShell', new THREE.BufferAttribute(new Float32Array(n).fill(t), 1));
        byMat.get(mesh.material).push(g);
      }
      src.dispose();
    }
    for (const [material, parts] of byMat) {
      const coat = new THREE.Mesh(mergeGeometries(parts), furMaterial(material, curl, shade));
      coat.receiveShadow = true;
      scene.add(coat);
      hideFromAO.push(coat);      // the solid surface underneath does the occluding
      parts.forEach(g => g.dispose());
    }
  }

  function tex(w, h, draw, repeatX = 1, repeatY = repeatX) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
    t.anisotropy = 8;
    return t;
  }

  // ---------- textures ----------
  // Soft blush plaster. One tile = 2.5 m.
  const plasterTex = tex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#f7e3e1'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1200; i++) {
      const x = rand() * w, y = rand() * h, r = 12 + rand() * 70;
      g.fillStyle = rand() < 0.5 ? 'rgba(255,250,246,0.06)' : 'rgba(214,168,170,0.045)';
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) { g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill(); }
    }
  }, 1 / 2.5);
  const stuccoTex = plasterTex;            // the window reveals use this name

  // Pale oak planks, 0.18 m wide; the texture holds eight of them (1.44 m square).
  const plankTex = tex(1024, 1024, (g, w, h) => {
    const n = 8, pw = w / n;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {                       // each plank is a few boards end to end
        const y0 = (k + (i % 2) * 0.5) * h / 3 % h;
        g.fillStyle = `hsl(${30 + rand() * 6}, ${36 + rand() * 10}%, ${80 + rand() * 6}%)`;
        g.fillRect(i * pw, y0, pw, h / 3);
        if (y0 + h / 3 > h) g.fillRect(i * pw, 0, pw, y0 + h / 3 - h);
        g.fillStyle = 'rgba(120,90,60,0.35)'; g.fillRect(i * pw, y0, pw, 2);
      }
      g.strokeStyle = 'rgba(150,115,80,0.16)';
      for (let k = 0; k < 14; k++) {
        const x = i * pw + 6 + rand() * (pw - 12);
        g.lineWidth = 1 + rand() * 2;
        g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + 6, h / 3, x - 6, 2 * h / 3, x, h); g.stroke();
      }
      g.fillStyle = 'rgba(110,80,55,0.45)'; g.fillRect(i * pw, 0, 2, h);
    }
  }, W / 1.44, D / 1.44);

  // Glazed bathroom tiles: mint and white checks, 0.15 m each (the texture holds 4 x 4).
  const tileTex = (rx, ry) => tex(256, 256, (g, s) => {
    g.fillStyle = '#f2efe9'; g.fillRect(0, 0, s, s);
    const q = s / 4;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      g.fillStyle = (i + j) % 2 ? '#bfe6d6' : '#fdfbf7';
      g.fillRect(i * q + 2, j * q + 2, q - 4, q - 4);
    }
  }, rx, ry);

  // The living-room rug: cream, scalloped pink border, a big flower in the middle and daisies about it.
  const rugTex = tex(1024, 732, (g, w, h) => {
    g.fillStyle = '#fff1e8'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f2a9bb'; g.lineWidth = 16;
    g.strokeRect(34, 34, w - 68, h - 68);
    g.fillStyle = '#f2a9bb';
    for (let x = 60; x < w - 40; x += 46) for (const y of [34, h - 34]) { g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill(); }
    for (let y = 60; y < h - 40; y += 46) for (const x of [34, w - 34]) { g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill(); }
    const cx = w / 2, cy = h / 2;
    g.fillStyle = '#9fd3b0';                                 // leaves either side, as drawn
    for (const s of [-1, 1]) { g.save(); g.translate(cx + s * 150, cy + 30); g.rotate(s * -0.5); g.beginPath(); g.ellipse(0, 0, 130, 44, 0, 0, Math.PI * 2); g.fill(); g.restore(); }
    for (let i = 0; i < 10; i++) {                           // the big flower
      const a = i / 10 * Math.PI * 2;
      g.fillStyle = i % 2 ? '#f6b3c4' : '#f9c7d4';
      g.save(); g.translate(cx + Math.cos(a) * 82, cy + Math.sin(a) * 82); g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, 78, 46, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
    g.fillStyle = '#ffd77a'; g.beginPath(); g.arc(cx, cy, 58, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 26; i++) {                           // daisies
      const x = 90 + rand() * (w - 180), y = 90 + rand() * (h - 180);
      if (Math.hypot(x - cx, y - cy) < 240) continue;
      g.fillStyle = '#ffffff';
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; g.beginPath(); g.ellipse(x + Math.cos(a) * 12, y + Math.sin(a) * 12, 10, 6, a, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#ffd77a'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    }
  });

  // Little hearts and stars on pink, for the duvet. One tile = 0.5 m.
  const duvetTex = tex(512, 512, (g, s) => {
    g.fillStyle = '#f9cfdb'; g.fillRect(0, 0, s, s);
    const heart = (x, y, k) => {
      g.save(); g.translate(x, y); g.scale(k, k); g.beginPath();
      g.moveTo(0, 8); g.bezierCurveTo(-22, -6, -12, -26, 0, -12); g.bezierCurveTo(12, -26, 22, -6, 0, 8); g.fill(); g.restore();
    };
    const star = (x, y, r) => {
      g.beginPath();
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      g.fill();
    };
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const x = (i + 0.25 + (j % 2) * 0.5) * s / 4, y = (j + 0.5) * s / 4;
      g.fillStyle = '#ffffff'; heart(x, y, 1.1);
      g.fillStyle = '#fff3b8'; star(x + s / 8, y + s / 9, 9);
    }
  }, 2, 2);

  // Polka dots: (background, dot colour, repeats).
  const dotsTex = (bg, dot, rx, ry = rx) => tex(256, 256, (g, s) => {
    g.fillStyle = bg; g.fillRect(0, 0, s, s);
    g.fillStyle = dot;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      g.beginPath(); g.arc((i + 0.25 + (j % 2) * 0.5) * s / 4, (j + 0.5) * s / 4, s / 22, 0, Math.PI * 2); g.fill();
    }
  }, rx, ry);

  // The desk plant's pot: cream with pink waves, as drawn.
  const wavyTex = tex(256, 128, (g, w, h) => {
    g.fillStyle = '#fff3ea'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f2a0b5'; g.lineWidth = 7;
    for (const y of [32, 64, 96]) { g.beginPath(); for (let x = 0; x <= w; x += 4) g.lineTo(x, y + 9 * Math.sin(x / w * Math.PI * 8)); g.stroke(); }
  });

  // The doormat: "Hi", as written on both mats in the sketch.
  const hiTex = tex(512, 320, (g, w, h) => {
    g.fillStyle = '#d9bb8c'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2500; i++) { g.fillStyle = rand() < 0.5 ? 'rgba(120,85,40,0.18)' : 'rgba(255,240,210,0.15)'; g.fillRect(rand() * w, rand() * h, 2, 6); }
    g.fillStyle = '#5a3a22'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 190px "Arial Rounded MT Bold", Arial, sans-serif'; g.fillText('Hi', w / 2, h / 2 + 8);
  });

  // A bunny cushion face.
  const bunnyFaceTex = tex(256, 256, (g, s) => {
    g.fillStyle = '#fff8f0'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#3a2a2e';
    for (const x of [96, 160]) { g.beginPath(); g.arc(x, 130, 10, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#f5a3b8'; g.beginPath(); g.ellipse(128, 150, 9, 6, 0, 0, Math.PI * 2); g.fill();
    for (const x of [74, 182]) { g.globalAlpha = 0.5; g.beginPath(); g.ellipse(x, 158, 16, 9, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    g.strokeStyle = '#3a2a2e'; g.lineWidth = 4;
    g.beginPath(); g.arc(120, 160, 8, 0, Math.PI); g.stroke(); g.beginPath(); g.arc(136, 160, 8, 0, Math.PI); g.stroke();
  });

  // The bedroom print: a rainbow and a cloud over a sleeping bunny and the moon.
  const printTex = tex(512, 666, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#d9e8fb'); bg.addColorStop(1, '#fbe3ec');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    ['#f6b3c4', '#fbd9a4', '#fff0a8', '#bfe6d6', '#c6dcf5', '#d9c8f0'].forEach((c, i) => {
      g.strokeStyle = c; g.lineWidth = 22; g.beginPath(); g.arc(w / 2, 420, 200 - i * 22, Math.PI, 0); g.stroke();
    });
    g.fillStyle = '#ffffff';
    for (const [x, y, r] of [[150, 410, 52], [210, 380, 64], [280, 400, 56], [340, 420, 44], [230, 430, 60]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#fff3b8'; g.beginPath(); g.arc(400, 110, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d9e8fb'; g.beginPath(); g.arc(420, 96, 42, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff8f0';                                  // bunny curled up on the cloud
    g.beginPath(); g.ellipse(250, 330, 56, 34, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(210, 300, 12, 34, -0.5, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(232, 294, 12, 34, -0.2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3a2a2e'; g.lineWidth = 3; g.beginPath(); g.arc(226, 328, 6, 0, Math.PI); g.stroke();
    g.fillStyle = '#8a7a9a'; g.font = 'italic 34px Georgia, serif'; g.textAlign = 'center'; g.fillText('sweet dreams', w / 2, 590);
  });

  const woodTex = (base, grain, rep = 1) => tex(1024, 1024, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    g.strokeStyle = grain;
    for (let i = 0; i < 260; i++) {
      const y = rand() * h;
      g.globalAlpha = 0.06 + rand() * 0.22; g.lineWidth = 1 + rand() * 3;
      g.beginPath(); g.moveTo(0, y);
      g.bezierCurveTo(w / 3, y + rand() * 14 - 7, 2 * w / 3, y + rand() * 14 - 7, w, y); g.stroke();
    }
    g.globalAlpha = 1;
  }, rep);

  const plaidTex = (base, band, line, rx, ry = rx) => tex(256, 256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = band; g.globalAlpha = 0.55;
    g.fillRect(0, 40, s, 68); g.fillRect(40, 0, 68, s);
    g.globalAlpha = 1; g.strokeStyle = line; g.lineWidth = 6;
    g.beginPath(); g.moveTo(0, 184); g.lineTo(s, 184); g.moveTo(184, 0); g.lineTo(184, s); g.stroke();
  }, rx, ry);

  const linenTex = (base, thread, rx, ry) => tex(256, 256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = thread;
    for (let i = 0; i < s; i += 4) {
      g.globalAlpha = 0.1 + rand() * 0.2; g.lineWidth = 1;
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); g.stroke();
    }
    g.globalAlpha = 1;
  }, rx, ry);

  const wovenTex = (rx, ry) => tex(256, 256, (g, s) => {
    g.fillStyle = '#e3c88c'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#a57f3e'; g.lineWidth = 5;
    for (let y = 16; y < s; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
    g.lineWidth = 3;
    for (let x = 16; x < s; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
  }, rx, ry);

  // Chunky knit for throws: ribs of little V stitches.
  const knitTex = (base, light, dark, rx, ry) => tex(128, 128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.lineWidth = 5; g.lineCap = 'round';
    for (let x = 0; x < s; x += 32) for (let y = -8; y < s; y += 16) {
      g.strokeStyle = light; g.beginPath(); g.moveTo(x + 4, y); g.lineTo(x + 16, y + 12); g.stroke();
      g.strokeStyle = dark; g.beginPath(); g.moveTo(x + 28, y); g.lineTo(x + 16, y + 12); g.stroke();
    }
  }, rx, ry);

  // The land outside. The room is high in a building on the cliff edge of a
  // hilltop town, so the country lies far below: a ring of distant ridges on the
  // horizon, then the valley floor falling away beneath the window, a patchwork
  // of fields, vineyards, white roads and farmhouses. Painted on a clear
  // background; the sky, the clouds and the light on the land come from the shader.
  const LAND = { w: 8192, h: 1280, horizon: 466 };        // the horizon sits 14 m up a 22 m tall backdrop
  const landTex = tex(LAND.w, LAND.h, (g, w, h) => {
    const H0 = LAND.horizon, wrap = draw => { for (const ox of [-w, 0, w]) draw(ox); };
    // two faint ridges right on the horizon, low enough for the sun to clear within minutes
    [['#8d8fb0', 0, 7, 3, 7], ['#7f879c', 14, 12, 4, 9]].forEach(([color, drop, amp, k1, k2]) => {
      const p1 = rand() * 6, p2 = rand() * 6;
      g.fillStyle = color;
      g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, H0 + drop + amp * Math.sin(x / w * Math.PI * 2 * k1 + p1) + amp * 0.5 * Math.sin(x / w * Math.PI * 2 * k2 + p2));
      g.lineTo(w, h); g.fill();
    });
    // the valley floor: rows of fields that grow as they come nearer (lower on the canvas)
    const palette = ['#6f7f45', '#8a8f4e', '#a39a5a', '#7b6f44', '#5f7340', '#93834f', '#4f6a3c', '#b0a468', '#667a3e', '#9c8f58'];
    const rows = 16, top = H0 + 30, rowY = i => top + (h - top) * Math.pow(i / rows, 1.7);
    for (let i = 0; i < rows; i++) {
      const y0 = rowY(i), y1 = rowY(i + 1), scale = 0.25 + i / rows * 2.2;
      let x = 0;
      while (x < w) {
        const fw = Math.min(w - x, (120 + rand() * 260) * scale), lean = (rand() - 0.5) * 60 * scale;
        g.fillStyle = palette[rand() * palette.length | 0];
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x + fw, y0); g.lineTo(x + fw + lean, y1 + 1); g.lineTo(x + lean, y1 + 1); g.fill();
        if (rand() < 0.3) {                               // a vineyard or ploughed field: fine parallel rows
          g.save(); g.clip(); g.strokeStyle = 'rgba(40,50,25,0.35)'; g.lineWidth = Math.max(1, scale);
          for (let k = x - 80; k < x + fw + 80; k += 7 * scale + 3) { g.beginPath(); g.moveTo(k, y0); g.lineTo(k + lean, y1); g.stroke(); }
          g.restore();
        }
        g.strokeStyle = 'rgba(38,52,30,0.7)'; g.lineWidth = 1.5 * scale;       // hedge down the side
        g.beginPath(); g.moveTo(x + fw, y0); g.lineTo(x + fw + lean, y1); g.stroke();
        x += fw;
      }
      g.fillStyle = 'rgba(38,52,30,0.7)'; g.fillRect(0, y0 - scale, w, 2 * scale);   // hedge along the top
      for (let k = 0; k < 46; k++) {                      // cypresses and round oaks
        const tx = rand() * w, ty = y0 + rand() * (y1 - y0), th = (7 + rand() * 9) * scale, cypress = rand() < 0.6;
        g.fillStyle = cypress ? '#26392a' : '#3c5230';
        wrap(ox => { g.beginPath(); g.ellipse(tx + ox, ty - th * (cypress ? 0.5 : 0.3), th * (cypress ? 0.16 : 0.42), th * (cypress ? 0.55 : 0.34), 0, 0, Math.PI * 2); g.fill(); });
      }
      if (i > 2 && i < 13) for (let k = 0; k < 5; k++) {  // farmhouses
        const fx = rand() * w, fy = y0 + (y1 - y0) * 0.5, u = 5 * scale;
        wrap(ox => {
          g.fillStyle = '#b9a586'; g.fillRect(fx + ox - u * 1.6, fy - u * 1.5, u * 3.2, u * 1.6);
          g.fillStyle = '#8a4a34'; g.beginPath(); g.moveTo(fx + ox - u * 2, fy - u * 1.5); g.lineTo(fx + ox, fy - u * 2.5); g.lineTo(fx + ox + u * 2, fy - u * 1.5); g.fill();
        });
      }
    }
    // white gravel roads winding down from the horizon
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let r = 0; r < 5; r++) {
      const baseX = (r + 0.5) * w / 5 + (rand() - 0.5) * 300, ph = rand() * 6;
      for (let i = 0; i < 60; i++) {
        const t0 = i / 60, t1 = (i + 1) / 60, at = t => [baseX + 380 * Math.sin(t * 7 + ph) * t + 200 * t, top + (h - top) * Math.pow(t, 1.7)];
        const [xa, ya] = at(t0), [xb, yb] = at(t1);
        g.strokeStyle = '#d9cdb4'; g.lineWidth = 1.5 + t0 * 16;
        wrap(ox => { g.beginPath(); g.moveTo(xa + ox, ya); g.lineTo(xb + ox, yb); g.stroke(); });
      }
    }
    // distance: haze thickest at the horizon, and mist lying in the valley
    const haze = g.createLinearGradient(0, H0 - 10, 0, H0 + 420);
    haze.addColorStop(0, 'rgba(176,170,196,0.85)'); haze.addColorStop(0.25, 'rgba(176,170,196,0.5)'); haze.addColorStop(1, 'rgba(176,170,196,0)');
    g.globalCompositeOperation = 'source-atop';          // only where land has been painted
    g.fillStyle = haze; g.fillRect(0, H0 - 10, w, 430);
    for (let i = 0; i < 36; i++) {
      const mx = rand() * w, my = H0 + 60 + rand() * 300, mw = 300 + rand() * 700;
      const mist = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      mist.addColorStop(0, 'rgba(255,236,226,0.5)'); mist.addColorStop(1, 'rgba(255,236,226,0)');
      wrap(ox => { g.save(); g.translate(mx + ox, my); g.scale(mw, 22 + rand() * 30); g.fillStyle = mist; g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill(); g.restore(); });
    }
    g.globalCompositeOperation = 'source-over';
  });

  // The neighbours to the south: plaster fronts with shuttered windows, pantile roofs.
  const facadeTex = tex(512, 512, (g, s) => {
    g.fillStyle = '#e9dcc4'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 500; i++) {                       // weathering
      g.fillStyle = rand() < 0.5 ? 'rgba(255,245,225,0.06)' : 'rgba(120,90,60,0.06)';
      g.beginPath(); g.arc(rand() * s, rand() * s, 8 + rand() * 50, 0, Math.PI * 2); g.fill();
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      const x = 64 + c * 170, y = 34 + r * 124, ww = 48, wh = 78;
      g.fillStyle = '#cbbd9f'; g.fillRect(x - 8, y - 8, ww + 16, wh + 18);         // stone surround
      g.fillStyle = '#1d2228'; g.fillRect(x, y, ww, wh);                           // dark glass
      g.fillStyle = (r + c) % 3 ? '#4f6a4a' : '#6b4a33';                           // shutters, some folded back
      if ((r * 3 + c) % 4 === 1) g.fillRect(x, y, ww, wh);
      else { g.fillRect(x - 26, y, 24, wh); g.fillRect(x + ww + 2, y, 24, wh); }
    }
  });
  const roofTex = tex(256, 256, (g, s) => {
    g.fillStyle = '#a8553a'; g.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) {
      g.fillStyle = `hsl(${12 + rand() * 10}, ${45 + rand() * 15}%, ${36 + rand() * 12}%)`; g.fillRect(x, 0, 11, s);
      g.fillStyle = 'rgba(40,15,8,0.45)'; g.fillRect(x + 11, 0, 5, s);
    }
    g.strokeStyle = 'rgba(40,15,8,0.3)'; g.lineWidth = 2;
    for (let y = 0; y < s; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
  }, 3, 2);

  // ---------- shared materials: a soft pastel palette with gold accents ----------
  const P = { pink: 0xf7c6d0, blush: 0xf9dfe3, mint: 0xbfe6d6, lilac: 0xd9c8f0, butter: 0xfbe7a6, sky: 0xc6e2f5, cream: 0xfff6ea, white: 0xfdfaf6 };
  const paint = c => mat(c, null, { roughness: 0.5 });
  const wood = (base, grain, rep) => { const t = woodTex(base, grain, rep); return mat(0xffffff, t, { bumpMap: t, bumpScale: 0.5, roughness: 0.6 }); };
  const oak = wood('#ecd9bd', '#c4a47c');
  const gold = mat(0xe2bd6b, null, { metalness: 0.85, roughness: 0.3 });
  const chrome = mat(0xeef0f3, null, { metalness: 1, roughness: 0.18 });
  const porcelain = mat(0xffffff, null, { roughness: 0.12 });
  const cream = paint(P.cream);
  const velvet = c => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.85, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xffffff) });
  const leafGreen = mat(0x6fae7c, null, { roughness: 0.6 });
  // the window parts: white frames, gold fittings
  const frameWood = paint(P.white), iron = gold, brass = gold, stone = paint(P.white);
  // Bevelled panes use real transmission, so the view outside bends at the bevels.
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, roughness: 0.02, ior: 1.52, thickness: 0.06, specularIntensity: 1 });
  // A box with properly round, soft edges (radius r), for the plump cartoon furniture.
  const soft = (w, h, d, r, material, x, y, z, parent) =>
    add(new RoundedBoxGeometry(w, h, d, 4, Math.min(r, Math.min(w, h, d) / 2.01)), material, x, y, z, parent);
  const turn = (pts, segs = 40) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);

  // ---------- lighting ----------
  // Every lamp is off. The only real light is the sun, and it moves: setSun()
  // near the end of this file drives everything declared here.
  scene.background = new THREE.Color(0x090b12);
  const skyFill = new THREE.HemisphereLight(0x7f93cc, 0x3c2a20, 0.1);     // what little the sky gives
  scene.add(skyFill);

  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.target.position.set(0, 1.3, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.015;
  sun.shadow.radius = 2;
  const sunBox = { left: -4.4, right: 4.4, top: 2.0, bottom: -2.0, near: 0.5, far: 18 };   // wide enough for the corners, seen at an angle
  Object.assign(sun.shadow.camera, sunBox);
  scene.add(sun, sun.target);

  // what the sunlit patches throw back: in front of the living-room window and the bedroom's east window
  const bounces = [[-0.4, 1.0, -1.3, 1.2], [2.35, 1.0, -1.9, 0.9]].map(([x, y, z, power]) => {
    const light = new THREE.PointLight(0xff9558, 0, 5, 2);
    light.position.set(x, y, z);
    scene.add(light);
    return [light, power];
  });

  // A dim procedural dawn for image-based fill and for reflections in glass, glaze and brass.
  {
    const pmrem = new THREE.PMREMGenerator(renderer), env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { sd: { value: new THREE.Vector3(0.12, 0.10, -1).normalize() } },
      vertexShader: 'varying vec3 d; void main(){ d = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: `varying vec3 d; uniform vec3 sd;
        void main(){ vec3 n = normalize(d);
          vec3 c = mix(vec3(.30,.20,.20), vec3(.06,.09,.22), smoothstep(-.05,.55,n.y));
          c = mix(vec3(.07,.05,.04), c, smoothstep(-.35,.0,n.y));
          float s = max(dot(n, sd), 0.);
          c += vec3(4.,1.7,.5) * pow(s, 10.) + vec3(.8,.35,.15) * pow(s, 2.5);
          gl_FragColor = vec4(c, 1.); }`,
    })));
    scene.environment = pmrem.fromScene(env, 0.03).texture;
    scene.environmentIntensity = 0.3;
    pmrem.dispose();
  }

  // ---------- the shell ----------
  const floor = add(new THREE.PlaneGeometry(W, D), mat(0xffffff, plankTex, { roughness: 0.55, bumpMap: plankTex, bumpScale: 0.4 }), 0, 0, 0);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  box(W + 0.24, 0.3, D + 0.24, mat(0x2a2326), 0, -0.152, 0).castShadow = false;   // the slab the home stands on
  const bathFloor = add(new THREE.PlaneGeometry(W / 2 - PX, D / 2 - PZ), mat(0xffffff, tileTex((W / 2 - PX) / 0.6, (D / 2 - PZ) / 0.6), { roughness: 0.25 }),
    (PX + W / 2) / 2, 0.002, (PZ + D / 2) / 2);
  bathFloor.rotation.x = -Math.PI / 2;
  bathFloor.castShadow = false;

  // Outer walls are single inward-facing sheets: they vanish when seen from
  // behind, yet still block the sun, so light only enters through the windows.
  // openings: [left, right, bottom, top] in the wall's own x; a bottom of 0 is a doorway.
  const wallMat = mat(0xffffff, plasterTex, { roughness: 1, shadowSide: THREE.DoubleSide, bumpMap: plasterTex, bumpScale: 0.5 });
  function wall(width, openings, x, z, rotY) {
    const s = new THREE.Shape(), doors = openings.filter(o => o[2] === 0).sort((a, b) => a[0] - b[0]);
    s.moveTo(-width / 2, 0);
    for (const [a, b, , top] of doors) { s.lineTo(a, 0); s.lineTo(a, top); s.lineTo(b, top); s.lineTo(b, 0); }
    s.lineTo(width / 2, 0); s.lineTo(width / 2, H); s.lineTo(-width / 2, H); s.closePath();
    for (const [a, b, y0, y1] of openings.filter(o => o[2] > 0)) {
      const hole = new THREE.Path();
      hole.moveTo(a, y0); hole.lineTo(a, y1); hole.lineTo(b, y1); hole.lineTo(b, y0); hole.closePath();
      s.holes.push(hole);
    }
    const m = add(new THREE.ShapeGeometry(s), wallMat, x, 0, z);
    m.rotation.y = rotY;
  }
  const LIVING_WINDOW = [U(0.4), U(0.54)];          // TV wall (east), between the two curtains
  const BED_WINDOW = [-0.6, 0.4];                     // bedroom's south wall, z range
  const BED_EAST_WINDOW = [1.85, 2.85];               // a second bedroom window, on the east wall, for the morning sun
  const FRONT_DOOR = [U(0.48), U(0.61)];              // south wall, x range, beside the partition
  wall(W, [[...LIVING_WINDOW, Y0, Y1], [...BED_EAST_WINDOW, Y0, Y1]], 0, -D / 2, 0);   // east (local x = world x)
  wall(D, [[...BED_WINDOW, Y0, Y1]], W / 2, 0, -Math.PI / 2);                  // east  (local x = world z)
  wall(W, [[-FRONT_DOOR[1], -FRONT_DOOR[0], 0, DOOR_H]], 0, D / 2, Math.PI);   // south (local x = -world x)
  wall(D, [], -W / 2, 0, Math.PI / 2);                                         // west
  const ceiling = add(new THREE.PlaneGeometry(W, D), mat(0xfffaf4, null, { roughness: 1, shadowSide: THREE.DoubleSide }), 0, H, 0);
  ceiling.rotation.x = Math.PI / 2;

  // The partitions, drawn as thick walls in the sketch: real blocks, with a
  // doorway from the living room into the bedroom and one from the bedroom into the bath.
  const inner = mat(0xffffff, plasterTex, { roughness: 1 }), cut = mat(0x3b3036, null, { roughness: 1 });
  const BED_DOOR = [V(0.32), V(0.47)];               // in the north-south partition, z range
  const BATH_DOOR = [U(0.81) - 0.03, U(0.897) + 0.03]; // in the east-west partition, x range
  // Where a partition is cut off (its top, and any end that meets an outer wall) it shows
  // the dark section colour of the base slab, as in an architect's cut-away model.
  const block = (x0, x1, z0, z1, y0 = 0, y1 = H) => {
    const ends = [x1 >= W / 2, x0 <= -W / 2, y1 >= H, false, z1 >= D / 2, z0 <= -D / 2];   // +x -x +y -y +z -z
    return add(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), ends.map(e => e ? cut : inner), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  };
  block(PX - T / 2, PX + T / 2, -D / 2, BED_DOOR[0]);
  block(PX - T / 2, PX + T / 2, BED_DOOR[0], BED_DOOR[1], DOOR_H);
  block(PX - T / 2, PX + T / 2, BED_DOOR[1], D / 2);
  block(PX + T / 2, BATH_DOOR[0], PZ - T / 2, PZ + T / 2);
  block(BATH_DOOR[0], BATH_DOOR[1], PZ - T / 2, PZ + T / 2, DOOR_H);
  block(BATH_DOOR[1], W / 2, PZ - T / 2, PZ + T / 2);
  // white architraves round both doorways, on both faces
  const trim = paint(P.white);
  for (const s of [-1, 1]) {
    const x = PX + s * (T / 2 + 0.01);
    for (const z of BED_DOOR) box(0.02, DOOR_H + 0.06, 0.07, trim, x, (DOOR_H + 0.06) / 2, z + (z === BED_DOOR[0] ? -0.035 : 0.035));
    box(0.02, 0.07, BED_DOOR[1] - BED_DOOR[0] + 0.14, trim, x, DOOR_H + 0.035, (BED_DOOR[0] + BED_DOOR[1]) / 2);
    const z = PZ + s * (T / 2 + 0.01);
    for (const x2 of BATH_DOOR) box(0.07, DOOR_H + 0.06, 0.02, trim, x2 + (x2 === BATH_DOOR[0] ? -0.035 : 0.035), (DOOR_H + 0.06) / 2, z);
    box(BATH_DOOR[1] - BATH_DOOR[0] + 0.14, 0.07, 0.02, trim, (BATH_DOOR[0] + BATH_DOOR[1]) / 2, DOOR_H + 0.035, z);
  }

  // ---------- the view outside ----------
  // Drawn only where a window opening is on screen (stencil), so it never shows
  // around or above the walls.
  const portalMat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  });
  const throughWindows = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc };
  const outside = new THREE.Group(), townMats = [];
  scene.add(outside);
  hideFromAO.push(outside);
  const sky = {                                                     // set by setSun()
    map: { value: landTex }, uSun: { value: sunDir },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
    uLand: { value: new THREE.Color() }, uCloud: { value: new THREE.Color() }, uDisc: { value: 0 }, uTime: { value: 0 },
  };
  const eye = 1.4, R = 20, tall = 22, y0 = eye - tall * (1 - LAND.horizon / LAND.h);   // horizon at eye level, most of the backdrop below it
  const pano = new THREE.Mesh(new THREE.CylinderGeometry(R, R, tall, 96, 1, true), new THREE.ShaderMaterial({
    uniforms: sky, side: THREE.BackSide, ...throughWindows,
    vertexShader: `varying vec3 vDir; varying vec2 vUv;
      void main(){ vUv = uv; vDir = (modelMatrix * vec4(position, 1.)).xyz - vec3(0., ${eye.toFixed(1)}, 0.);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 uSun, uZenith, uHorizon, uGlow, uLand, uCloud; uniform float uDisc, uTime;
      varying vec3 vDir; varying vec2 vUv;
      float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y); }
      float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2(17., 9.); a *= .5; } return s; }
      void main(){
        vec3 d = normalize(vDir);
        float toSun = max(dot(d, uSun), 0.);
        float sameSide = max(dot(normalize(d.xz), normalize(uSun.xz)), 0.);
        vec3 c = mix(uHorizon, uZenith, pow(clamp(d.y * 2.2 + .02, 0., 1.), .55));
        c += uGlow * (.55 * pow(toSun, 6.) + .9 * pow(toSun, 40.) + .5 * exp(-abs(d.y) * 9.) * pow(sameSide, 3.));
        c += uDisc * vec3(1., .42, .1) * smoothstep(.99988, .99993, dot(d, uSun));          // the sun's disc
        if (d.y > 0.) {                                                                      // clouds, on a flat layer overhead
          vec2 cp = d.xz / (d.y + .12) * 1.4 + vec2(uTime * .012, uTime * .004);             // drifting on the wind
          float dens = fbm(cp), cover = smoothstep(.5, .74, dens);
          float thin = clamp((dens - fbm(cp + normalize(uSun.xz) * .35)) * 3. + .5, 0., 1.); // less cloud towards the sun = lit side
          vec3 cl = mix(uCloud * .3, uCloud * 1.5 + uGlow * .7 * pow(toSun, 2.), thin);
          cl += uGlow * 1.4 * pow(toSun, 12.) * (1. - cover * .5);                           // edges catch fire near the sun
          c = mix(c, cl, cover * smoothstep(0., .1, d.y) * .92);
        }
        vec4 t = texture2D(map, vUv);                                                        // the land, in front of all that
        gl_FragColor = vec4(mix(c, t.rgb * uLand * (1. + 1.5 * pow(sameSide, 4.)), t.a), 1.);
      }`,
  }));
  pano.position.y = y0 + tall / 2;
  pano.renderOrder = -1;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ ...throughWindows }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = y0;
  ground.renderOrder = -1;
  outside.add(pano, ground);

  // The town climbs away to the south: a neighbour across the lane, lower roofs
  // stepping down towards the cliff edge, and the bell tower beyond. The valley
  // opens to the east, below the TV-wall window. Real geometry, so it shifts as you move and takes the
  // sunrise on its east faces.
  {
    const seenThrough = m => Object.assign(m, throughWindows);
    // Out of doors the whole sky lights a wall, far more than it lights our room.
    // That open-air skylight is given to these materials as a glow that setSun() raises with the dawn.
    const openAir = (map, tint) => {
      const m = seenThrough(new THREE.MeshStandardMaterial({ map, color: tint, roughness: 1, emissiveMap: map, emissive: 0x000000 }));
      townMats.push([m, new THREE.Color(tint)]);
      return m;
    };
    const wallMat = tint => openAir(facadeTex, tint);
    const tiles = openAir(roofTex, 0xffffff);
    const hip = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4);      // a hipped roof one unit square
    const street = -9;                                                                 // how far below our floor the lane is
    function house(x, z, w, d, eave, tint, pitch = 1.3) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, eave - street, d), wallMat(tint));
      body.position.set(x, (eave + street) / 2, z);
      const roof = new THREE.Mesh(hip, tiles);
      roof.scale.set(w + 0.5, pitch, d + 0.5);
      roof.position.set(x, eave + pitch / 2, z);
      outside.add(body, roof);
    }
    house(8.6, -1.2, 5.2, 7.6, 2.9, 0xf3dccb);           // across the lane, filling the bedroom's south window
    house(10.8, 6.4, 6, 5, -0.6, 0xe9c9a0, 1.5);         // lower, towards the cliff: we look down on its roof
    house(10.2, -8.2, 5, 5.5, 0.9, 0xf2e2c4);
    house(15.2, 10.2, 4, 4.5, -2.2, 0xe3b98e, 1.2);     // right on the cliff edge
    house(16, -3.2, 6, 6, 4.2, 0xead2b0);
    house(14.6, 3.4, 2.6, 2.6, 8.2, 0xdcc9a8, 2.2);     // the bell tower
    const belfry = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.3, 2.7), seenThrough(new THREE.MeshStandardMaterial({ color: 0x3a3026, roughness: 1 })));
    belfry.position.set(14.6, 7.0, 3.4);                 // the dark openings where the bells hang
    const cypress = new THREE.Mesh(new THREE.ConeGeometry(0.7, 6.5, 10), seenThrough(new THREE.MeshStandardMaterial({ color: 0x24382a, roughness: 1 })));
    cypress.position.set(6.4, -1.6, 3.6);
    outside.add(belfry, cypress);
  }

  // ---------- windows ----------
  function paneGeo(pw, ph) {
    const b = 0.022, a = pw / 2 - b, c = ph / 2 - b, s = new THREE.Shape();
    s.moveTo(-a, -c); s.lineTo(a, -c); s.lineTo(a, c); s.lineTo(-a, c); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: true, bevelSize: b, bevelThickness: 0.007, bevelSegments: 1 });
    geo.translate(0, 0, -0.002);
    return geo;
  }

  // A two-leaf wooden casement, three bevelled panes per leaf, with a handle on each leaf.
  // open = how far each leaf is swung into the room, in radians: [left, right]
  function casement(w, h, parent, open = [0, 0]) {
    const f = 0.05, st = 0.045, mu = 0.024;
    for (const s of [-1, 1]) {
      box(w, f, 0.07, frameWood, 0, s * (h - f) / 2, 0, parent);
      box(f, h - 2 * f, 0.07, frameWood, s * (w - f) / 2, 0, 0, parent);
    }
    const iw = w - 2 * f, ih = h - 2 * f, lw = iw / 2;
    const pw = lw - 2 * st, ph = (ih - 2 * st - 2 * mu) / 3;
    const geo = paneGeo(pw, ph);
    for (const s of [-1, 1]) {
      const hinge = group(s * iw / 2, 0, 0.012, s * open[s < 0 ? 0 : 1], parent);
      const leaf = group(-s * lw / 2, 0, 0, 0, hinge);
      for (const t of [-1, 1]) {
        box(st, ih, 0.045, frameWood, t * (lw - st) / 2, 0, 0, leaf);
        box(pw, st, 0.045, frameWood, 0, t * (ih - st) / 2, 0, leaf);
      }
      for (let i = -1; i <= 1; i++) {
        const pane = new THREE.Mesh(geo, glass);
        pane.position.y = i * (ph + mu);
        leaf.add(pane);
        hideFromAO.push(pane);
        if (i < 1) box(pw, mu, 0.035, frameWood, 0, (i + 0.5) * (ph + mu), 0, leaf);
      }
      // handle: iron plate fixed to the stile, a short stem, then the brass knob
      const hx = -s * (lw - st) / 2, face = 0.0225;
      box(0.026, 0.15, 0.008, iron, hx, -0.05, face + 0.004, leaf);
      cyl(0.006, 0.006, 0.035, iron, hx, -0.05, face + 0.0255, leaf).rotation.x = Math.PI / 2;
      ball(0.019, brass, hx, -0.05, face + 0.053, leaf, 1, 1, 0.8);
    }
  }

  // tie: the edge (-1 or +1) a tie-back gathers the curtain towards, or 0 to let it hang straight
  function curtain(width, height, material, tie = 0) {
    const geo = new THREE.PlaneGeometry(width, height, 80, tie ? 30 : 1), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), z = 0.028 * Math.sin(x / width * Math.PI * 9);
      if (tie) {
        const up = p.getY(i) / height + 0.5, pinch = Math.exp(-(((up - 0.42) / 0.2) ** 2)) * 0.72;
        x = x * (1 - pinch) + tie * width / 2 * pinch;
        z *= 1 + pinch * 0.8;
      }
      p.setX(i, x);
      p.setZ(i, z);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, material);
    m.castShadow = m.receiveShadow = true;
    return m;
  }

  // The breeze. Curtains by the open window are pinned at the rod and free at
  // the hem; the wind comes in swells, pushing them into the room and letting
  // them fall back. The same motion is applied wherever those curtains are
  // drawn (colour, shadow, and the depth map the light beams use).
  const wind = { uTime: { value: 0 }, uWind: { value: 0 } };
  const blown = material => {
    material.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, wind);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime, uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float hang = 1. - uv.y, free = hang * hang;
          float swell = .55 + .45 * sin(uTime * .6) * sin(uTime * .23 + 1.3);
          float ripple = .5 + .5 * sin(uTime * 1.7 - hang * 3.2 + position.x * 5.);
          transformed.z += uWind * free * swell * (.09 + .06 * ripple);
          transformed.x += uWind * free * .035 * sin(uTime * 1.1 + hang * 4.);
          transformed.y += uWind * free * swell * .02;`);
    };
    material.customProgramCacheKey = () => 'blown';
    return material;
  };
  const windCurtains = [];
  const blownDepth = blown(new THREE.MeshDepthMaterial({ side: THREE.DoubleSide }));
  const blownMask = blown(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));

  // A window set `depth` metres into the wall, with an iron rod and a pair of curtains.
  function windowUnit(w, depth, x, z, rotY, curtainMat, curtainBottom, open, tied) {
    const h = Y1 - Y0, g = group(x, (Y0 + Y1) / 2, z, rotY);
    const portal = new THREE.Mesh(new THREE.PlaneGeometry(w, h), portalMat);
    portal.renderOrder = -2;
    g.add(portal);
    hideFromAO.push(portal);
    // the reveal: plaster cheeks and head, a stone sill
    const plaster = mat(0xffffff, stuccoTex, { roughness: 1, shadowSide: THREE.DoubleSide });
    const sillStone = mat(0xe6dcc4, null, { roughness: 0.9, shadowSide: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const cheek = add(new THREE.PlaneGeometry(depth, h), plaster, s * w / 2, 0, -depth / 2, g);
      cheek.rotation.y = -s * Math.PI / 2;
      const lid = add(new THREE.PlaneGeometry(w, depth), s < 0 ? sillStone : plaster, 0, s * h / 2, -depth / 2, g);
      lid.rotation.x = s * Math.PI / 2;
    }
    box(w + 0.1, 0.035, 0.06, stone, 0, -h / 2 - 0.0175, 0.03, g);          // sill nosing
    casement(w, h, group(0, 0, -depth + 0.035, 0, g), open);

    const rodY = h / 2 + 0.12, rodLen = w + 0.56, yb = curtainBottom - (Y0 + Y1) / 2;
    cyl(0.011, 0.011, rodLen, iron, 0, rodY, 0.09, g).rotation.z = Math.PI / 2;
    for (const s of [-1, 1]) {
      ball(0.024, iron, s * rodLen / 2, rodY, 0.09, g);
      box(0.012, 0.012, 0.09, iron, s * (w / 2 + 0.2), rodY, 0.045, g);
      const c = curtain(0.32, rodY - yb, curtainMat, tied ? s : 0);
      c.position.set(s * (w / 2 + 0.09), (rodY + yb) / 2, 0.09);
      g.add(c);
      if (tied) {                                  // the tie-back band
        const band = add(new THREE.TorusGeometry(0.035, 0.01, 8, 24), brass, s * (w / 2 + 0.09 + 0.16 * 0.72), yb + 0.42 * (rodY - yb), 0.09, g);
        band.rotation.x = Math.PI / 2;
        band.scale.set(1, 1.6, 1);
      }
      if (open) { c.customDepthMaterial = blownDepth; windCurtains.push(c); }
    }
    return g;
  }

  // ---------- window placements ----------
  const sheerPink = mat(0xffffff, linenTex('#fbe1e8', '#e9b3c3', 3, 10), { side: THREE.DoubleSide });
  const DEEP = 0.3;                                                     // old stone walls: windows sit back in them
  const lw = LIVING_WINDOW[1] - LIVING_WINDOW[0];
  windowUnit(lw, DEEP, (LIVING_WINDOW[0] + LIVING_WINDOW[1]) / 2, -D / 2, 0, sheerPink, 0.06, undefined, true);   // living room: shut, curtains tied back
  windowUnit(BED_EAST_WINDOW[1] - BED_EAST_WINDOW[0], DEEP, (BED_EAST_WINDOW[0] + BED_EAST_WINDOW[1]) / 2, -D / 2, 0, sheerPink, 0.7, undefined, true);   // bedroom, east: shut, tied back
  const breezySheer = blown(new THREE.MeshStandardMaterial({ map: sheerPink.map, roughness: 0.85, side: THREE.DoubleSide }));
  windowUnit(BED_WINDOW[1] - BED_WINDOW[0], DEEP, W / 2, (BED_WINDOW[0] + BED_WINDOW[1]) / 2, -Math.PI / 2, breezySheer, 0.72, [1.4, 1.3]);   // bedroom, south: open, with the breeze

  // ---------- small shared pieces ----------
  const heartShape = k => {
    const s = new THREE.Shape();
    s.moveTo(0, -0.5 * k);
    s.bezierCurveTo(-0.15 * k, -0.35 * k, -0.55 * k, -0.1 * k, -0.5 * k, 0.18 * k);
    s.bezierCurveTo(-0.45 * k, 0.48 * k, -0.08 * k, 0.5 * k, 0, 0.25 * k);
    s.bezierCurveTo(0.08 * k, 0.5 * k, 0.45 * k, 0.48 * k, 0.5 * k, 0.18 * k);
    s.bezierCurveTo(0.55 * k, -0.1 * k, 0.15 * k, -0.35 * k, 0, -0.5 * k);
    return s;
  };
  const starShape = (r, inner = 0.5) => {
    const s = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2 + Math.PI / 2, rr = i % 2 ? r * inner : r;
      i ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    return s;
  };
  // a plump shape cut from a flat outline, standing up and facing +z
  const puffed = (shape, depth, bevel) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5, curveSegments: 24 });
    g.center();
    return g;
  };
  // a chest of drawers built facing +z, then turned into place
  function drawers(w, h, d, rows, cols, x, z, rotY, body, front) {
    const g = group(x, 0, z, rotY), foot = 0.07;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(0.022, 0.014, foot, gold, sx * (w / 2 - 0.06), foot / 2, sz * (d / 2 - 0.06), g);
    soft(w, h - foot, d, 0.03, body, 0, foot + (h - foot) / 2, 0, g);
    const cw = w / cols, rh = (h - foot - 0.05) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const dx = (c + 0.5) * cw - w / 2, dy = foot + 0.025 + (r + 0.5) * rh;
      soft(cw - 0.04, rh - 0.035, 0.02, 0.008, front, dx, dy, d / 2 + 0.006, g);
      ball(0.016, gold, dx, dy, d / 2 + 0.025, g);
    }
    return g;
  }
  const book = (w, h, d, color, x, y, z, rotY, parent) => {
    const b = group(x, y, z, rotY, parent);
    box(w, h, d, paint(color), 0, h / 2, 0, b);
    box(w - 0.012, h - 0.012, d - 0.006, cream, 0.004, h / 2, 0, b);
    return b;
  };
  function picture(map, w, h, border, frameMat, parent) {
    flat(w + border * 2, h + border * 2, frameMat, 0, 0, 0, parent);
    flat(w, h, new THREE.MeshStandardMaterial({ map, roughness: 0.6 }), 0, 0, 0.003, parent);
  }
  // a pastel lampshade (lamps are off: it is sunrise)
  const shadeMat = (color, map) => new THREE.MeshStandardMaterial({ color, map, emissiveMap: map, emissive: 0x000000, roughness: 0.9, side: THREE.DoubleSide });
  const bulbMat = () => new THREE.MeshStandardMaterial({ color: 0xfff8e8, emissive: 0x000000, roughness: 0.3 });

  // ---------- lamps you can click ----------
  // Every lamp starts off. Each one's light exists from the start at zero brightness,
  // so switching it on never makes the shaders rebuild; a click only sets numbers.
  // An invisible cylinder around each lamp is what the click actually hits.
  const lamps = [];
  function lamp(x, y, z, { hit: [r, h], shades, bulb, power, distance = 5 }) {
    const light = new THREE.PointLight(0xffb978, 0, distance, 2);
    light.position.set(x, y, z);
    scene.add(light);
    const proxy = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(x, h / 2, z);
    scene.add(proxy);
    lamps.push({ light, proxy, shades, bulb, power, on: false });
  }
  function setLamp(l, on) {
    l.on = on;
    l.light.intensity = on ? l.power : 0;
    for (const m of l.shades) { m.emissive.setRGB(1, 0.72, 0.45); m.emissiveIntensity = on ? 0.9 : 0; }
    l.bulb.emissive.setRGB(1, 0.8, 0.55);
    l.bulb.emissiveIntensity = on ? 8 : 0;
  }
  function potPlant(x, y, z, potR, potH, potMat, leaves, leafLen, spread) {
    const g = group(x, y, z);
    add(turn([[0, 0], [potR * 0.78, 0], [potR, potH * 0.92], [potR * 1.04, potH], [potR * 0.92, potH]], 32), potMat, 0, 0, 0, g);
    cyl(potR * 0.9, potR * 0.9, 0.01, mat(0x5a4636), 0, potH - 0.012, 0, g);
    const up = new THREE.Vector3(0, 1, 0), list = [];
    for (let i = 0; i < leaves; i++) {
      const a = i * 2.39996, tilt = 0.25 + (i % 3) * spread, len = leafLen * (0.75 + rand() * 0.4);
      const dir = new THREE.Vector3(Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a));
      const at = new THREE.Vector3(0, potH, 0).addScaledVector(dir, len * 0.55);
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir).multiply(new THREE.Quaternion().setFromAxisAngle(up, a));
      list.push(new THREE.Matrix4().compose(at, q, new THREE.Vector3(len * 0.32, len / 2, len * 0.05)));
    }
    scatter(new THREE.SphereGeometry(1, 14, 10), leafGreen, list, g);
    return g;
  }
  // a cuddly toy rabbit; everything but the face is plush
  function bunnyToy(x, y, z, rotY, fur, k = 1) {
    const g = group(x, y, z, rotY), plush = [];
    const part = (r, m, px, py, pz, sx = 1, sy = 1, sz = 1, rz = 0) => {
      const p = add(new THREE.SphereGeometry(r, 20, 14), m, px * k, py * k, pz * k, g);
      p.scale.set(sx * k, sy * k, sz * k);
      p.rotation.z = rz;
      if (m === fur) plush.push(p);
      return p;
    };
    part(1, fur, 0, 0.1, 0, 0.1, 0.11, 0.09);                         // body
    part(1, fur, 0, 0.24, 0.015, 0.085, 0.08, 0.08);                  // head
    for (const s of [-1, 1]) {
      part(1, fur, s * 0.04, 0.36, 0, 0.024, 0.075, 0.016, -s * 0.18);   // ears
      part(1, paint(0xf7b7c6), s * 0.042, 0.36, 0.012, 0.012, 0.055, 0.006, -s * 0.18);
      part(1, fur, s * 0.05, 0.03, 0.06, 0.035, 0.028, 0.045);         // feet
      part(0.011, paint(0x2a1e22), s * 0.03, 0.255, 0.088);            // eyes
    }
    part(0.012, paint(0xf59ab2), 0, 0.235, 0.094);                    // nose
    part(0.03, fur, 0, 0.09, -0.09);                                  // tail
    fluff(plush, { length: 0.008 * k, layers: 10, strand: 0.002 * k, droop: 0.1, shade: 0.7 });
    return g;
  }

  // The toy on the bed, from Natalie's photos: a yellow plush chick about 30 cm tall,
  // its round head wider than its body, stubby wings, a red three-lobed comb, a pouty
  // orange beak, brown eyes, pink swirl cheeks, big orange feet and a pink stitched x.
  function chickToy(x, y, z, rotY) {
    const g = group(x, y, z, rotY), plush = [];
    const yellow = mat(0xf0e35a, null, { roughness: 1 }), orange = mat(0xf59a3a, null, { roughness: 0.9 });
    const red = mat(0xd9302c, null, { roughness: 0.9 }), brown = mat(0x3a2216, null, { roughness: 0.35 }), stitch = paint(0xe57d9b);
    const part = (r, m, px, py, pz, sx = 1, sy = 1, sz = 1, fur = true) => {
      const p = add(new THREE.SphereGeometry(r, 22, 16), m, px, py, pz, g);
      p.scale.set(sx, sy, sz);
      if (fur) plush.push(p);
      return p;
    };
    // feet, with three toes each
    for (const s of [-1, 1]) {
      part(1, orange, s * 0.045, 0.022, 0.03, 0.042, 0.024, 0.058);
      for (const t of [-1, 0, 1]) part(0.016, orange, s * 0.045 + t * 0.022, 0.02, 0.083, 1, 0.9, 1);
    }
    part(1, yellow, 0, 0.105, 0, 0.085, 0.085, 0.075);                                   // body
    for (const s of [-1, 1]) {                                                          // wings, sticking out and down
      const w = part(1, yellow, s * 0.088, 0.125, 0.005, 0.045, 0.02, 0.035);
      w.rotation.z = -s * 0.55;
    }
    const HX = 0.115, HY = 0.1, HZ = 0.092, hy = 0.255;
    part(1, yellow, 0, hy, 0, HX, HY, HZ);                                               // head
    for (const i of [-1, 0, 1]) {                                                       // comb
      const c = part(0.024, red, i * 0.026, hy + HY - 0.004 + (i ? 0 : 0.012), -0.008, 0.9, 1.35, 0.8, false);
      c.rotation.z = -i * 0.45;
    }
    // features sit on the surface of the head, just proud of the fur
    const onHead = (px, py, lift) => {
      const pz = HZ * Math.sqrt(Math.max(0, 1 - (px / HX) ** 2 - (py / HY) ** 2));
      const n = new THREE.Vector3(px / (HX * HX), py / (HY * HY), pz / (HZ * HZ)).normalize();
      return [new THREE.Vector3(px, hy + py, pz).addScaledVector(n, lift), n];
    };
    const z1 = new THREE.Vector3(0, 0, 1);
    for (const s of [-1, 1]) {
      const [at, n] = onHead(s * 0.042, 0.012, 0.008);
      const eye = part(1, brown, at.x, at.y, at.z, 0.0115, 0.0155, 0.006, false);
      eye.quaternion.setFromUnitVectors(z1, n);
      part(0.0035, paint(0xffffff), at.x + s * 0.003, at.y + 0.006, at.z + 0.004, 1, 1, 1, false);
      const [ca, cn] = onHead(s * 0.074, -0.03, 0.008);                                  // swirl cheeks: two rings
      for (const r of [0.015, 0.008]) {
        const ring = add(new THREE.TorusGeometry(r, 0.0022, 6, 28), stitch, ca.x, ca.y, ca.z, g);
        ring.quaternion.setFromUnitVectors(z1, cn);
      }
    }
    const [ba] = onHead(0, -0.014, 0.012);                                               // beak: a pouty upper and lower lip
    part(1, orange, ba.x, ba.y, ba.z, 0.031, 0.015, 0.024, false);
    part(1, orange, ba.x, ba.y - 0.017, ba.z - 0.004, 0.025, 0.011, 0.018, false);
    for (const a of [0.8, -0.8]) {                                                      // the little x on the tummy
      const st = box(0.018, 0.003, 0.003, stitch, 0, 0.075, 0.082, g);
      st.rotation.z = a;
    }
    fluff(plush, { length: 0.0065, layers: 10, strand: 0.0017, droop: 0.05, shade: 0.75 });
    return g;
  }

  // ---------- living room: TV on a console against the east wall ----------
  {
    const g = group(U(0.245), 0, -D / 2 + 0.22);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(0.02, 0.012, 0.14, gold, sx * 0.66, 0.07, sz * 0.14, g);
    soft(1.5, 0.36, 0.4, 0.04, paint(P.white), 0, 0.14 + 0.18, 0, g);
    for (const sx of [-1, 1]) {
      soft(0.68, 0.26, 0.02, 0.01, paint(P.pink), sx * 0.36, 0.32, 0.205, g);
      ball(0.018, gold, sx * 0.36, 0.32, 0.225, g);
    }
    soft(0.34, 0.02, 0.2, 0.008, paint(0x3a3a40), 0, 0.51, -0.02, g);                         // TV foot
    cyl(0.022, 0.022, 0.2, chrome, 0, 0.61, -0.04, g);
    soft(1.2, 0.7, 0.045, 0.012, mat(0x1d1d22, null, { roughness: 0.3 }), 0, 1.06, -0.04, g);   // TV
    flat(1.16, 0.66, mat(0x07080b, null, { roughness: 0.06 }), 0, 1.06, -0.016, g);            // screen, switched off
    bunnyToy(U(0.245) + 0.55, 0.5, -D / 2 + 0.27, -0.3, paint(P.cream), 0.55);                                      // a little rabbit sitting on the console
  }

  // ---------- the flower rug, the sofa on it facing the TV ----------
  {
    const rx = U(0.245), rz = -1.25, rw = 2.8, rd = 2.0;
    soft(rw, 0.014, rd, 0.007, mat(0xf2a9bb), rx, 0.007, rz).castShadow = false;
    const top = add(new THREE.PlaneGeometry(rw - 0.02, rd - 0.02), mat(0xffffff, rugTex, { roughness: 1 }), rx, 0.0145, rz);
    top.rotation.x = -Math.PI / 2;
    top.castShadow = false;
    fluff([top], { length: 0.01, layers: 8, strand: 0.0035, curl: 0.3, shade: 0.8, uvSize: [rw, rd] });
  }
  {
    // L-shaped, facing north, the chaise (the leg-rest) on its left, which is the west end
    const fabric = velvet(0xd9c8f0);
    const x0 = -3.35, x1 = -0.95, z0 = -1.15, z1 = -0.25, chaiseX = -2.55, chaiseZ = -1.95, arm = 0.2, backT = 0.2;
    for (const [x, z] of [[x0 + 0.08, chaiseZ + 0.08], [chaiseX - 0.08, chaiseZ + 0.08], [x0 + 0.08, z1 - 0.08], [x1 - 0.08, z1 - 0.08], [x1 - 0.08, z0 + 0.08]])
      cyl(0.025, 0.017, 0.08, gold, x, 0.04, z);
    soft(x1 - x0, 0.24, z1 - z0, 0.06, fabric, (x0 + x1) / 2, 0.2, (z0 + z1) / 2);                  // base, main run
    soft(chaiseX - x0, 0.24, z0 - chaiseZ + 0.02, 0.06, fabric, (x0 + chaiseX) / 2, 0.2, (chaiseZ + z0) / 2 - 0.01);   // base, chaise
    soft(x1 - x0, 0.42, backT, 0.08, fabric, (x0 + x1) / 2, 0.32 + 0.21, z1 - backT / 2);             // back
    soft(arm, 0.32, z1 - z0, 0.09, fabric, x1 - arm / 2, 0.32 + 0.16, (z0 + z1) / 2);                 // arm, east end
    const seatY = 0.32, seatT = 0.14;
    const seat = (w, d, x, z) => add(pillowGeo(w, d, seatT), fabric, x, seatY + seatT * 0.45, z);
    const seatD = z1 - backT - z0;
    seat((x1 - arm - chaiseX) / 2 - 0.01, seatD, chaiseX + (x1 - arm - chaiseX) / 4, z0 + seatD / 2);
    seat((x1 - arm - chaiseX) / 2 - 0.01, seatD, chaiseX + 3 * (x1 - arm - chaiseX) / 4, z0 + seatD / 2);
    seat(chaiseX - x0 - 0.02, z1 - backT - chaiseZ, (x0 + chaiseX) / 2, (chaiseZ + z1 - backT) / 2);
    // back cushions, standing on the seat and leaning on the back
    const backTilt = -Math.PI / 2 + 0.18, cy = seatY + seatT + 0.2;
    for (const x of [-2.92, -2.22, -1.52]) {
      const c = add(pillowGeo(0.66, 0.42, 0.18), fabric, x, cy, z1 - backT - 0.1);
      c.rotation.x = backTilt;
    }
    // four throw cushions in front of them, spaced apart: a heart, a round one, a bunny face, a star
    const front = z1 - backT - 0.1 - 0.17, lean = -0.2, sitY = seatY + seatT;
    const heart = add(puffed(heartShape(0.36), 0.05, 0.035), velvet(0xf7a8bd), -2.98, sitY + 0.17, front);
    heart.rotation.set(-lean, Math.PI, 0);
    const round = ball(1, velvet(0xbfe6d6), -2.42, sitY + 0.16, front, scene, 0.16, 0.16, 0.06);
    round.rotation.x = lean;
    ball(0.02, gold, -2.42, sitY + 0.16 + 0.012, front - 0.062, scene);
    const bunny = add(pillowGeo(0.32, 0.32, 0.12), mat(0xffffff, bunnyFaceTex), -1.88, sitY + 0.16, front);
    bunny.rotation.set(-Math.PI / 2 - lean, 0, Math.PI);                                              // face to the room
    for (const s of [-1, 1]) { const ear = ball(1, paint(P.cream), -1.88 + s * 0.07, sitY + 0.36, front + 0.03, scene, 0.035, 0.08, 0.025); ear.rotation.set(lean, 0, -s * 0.2); }
    const star = add(puffed(starShape(0.16, 0.52), 0.05, 0.03), velvet(0xfbe7a6), -1.4, sitY + 0.16, front);
    star.rotation.set(-lean, Math.PI, 0);
    fluff([bunny], { length: 0.006, layers: 7, strand: 0.0018, shade: 0.8, uvSize: [0.32, 0.32] });
  }

  // ---------- the living-room window: tied-back curtains, and a mushroom lamp beside it ----------
  {
    const g = group(LIVING_WINDOW[1] + 0.5, 0, -D / 2 + 0.3);
    cyl(0.15, 0.17, 0.03, paint(P.white), 0, 0.015, 0, g);
    cyl(0.018, 0.018, 1.22, paint(P.white), 0, 0.63, 0, g);
    const shade = shadeMat(0xffffff, dotsTex('#f7b9c8', '#ffffff', 6, 2)), bulb = bulbMat();
    add(turn([[0.24, 0], [0.235, 0.03], [0.2, 0.12], [0.13, 0.19], [0.05, 0.22], [0, 0.225]], 48), shade, 0, 1.22, 0, g);
    ball(0.05, bulb, 0, 1.22, 0, g);
    lamp(g.position.x, 1.15, g.position.z, { hit: [0.26, 1.48], shades: [shade], bulb, power: 1.6 });
  }

  // ---------- kitchen along the west wall: cooktop, sink, mint cupboards ----------
  {
    const z0 = V(0.54), z1 = V(0.81), L = z1 - z0, dep = 0.6, top = 0.9;
    // turned so the cupboard fronts face east; local x runs north (+) to south (-)
    const g = group(-W / 2 + dep / 2, 0, (z0 + z1) / 2, Math.PI / 2);
    box(L, 0.08, dep - 0.06, paint(0xe9e2da), 0, 0.04, -0.03, g);
    soft(L, top - 0.12, dep - 0.02, 0.02, paint(P.mint), 0, 0.08 + (top - 0.12) / 2, -0.01, g);
    for (let i = 0; i < 3; i++) {
      const dx = (i + 0.5) * L / 3 - L / 2;
      soft(L / 3 - 0.03, top - 0.18, 0.02, 0.01, paint(0xcdeee0), dx, 0.08 + (top - 0.12) / 2, dep / 2 - 0.005, g);
      ball(0.017, gold, dx + (i === 1 ? 0 : -Math.sign(dx) * (L / 6 - 0.07)), top - 0.2, dep / 2 + 0.02, g);
    }
    soft(L + 0.02, 0.04, dep + 0.02, 0.012, mat(0xfefcf9, null, { roughness: 0.25 }), 0, top - 0.02, 0, g);
    // cooktop at the north end, with the kettle on it
    const cx = L / 2 - 0.34;
    box(0.55, 0.008, 0.46, mat(0x111114, null, { roughness: 0.08 }), cx, top + 0.004, 0, g);
    for (const dx of [-0.13, 0.13]) {
      const ring = add(new THREE.RingGeometry(0.06, 0.075, 40), mat(0x55555c, null, { roughness: 0.4 }), cx + dx, top + 0.009, 0.03, g);
      ring.rotation.x = -Math.PI / 2;
    }
    const kettle = group(cx + 0.13, top + 0.01, 0.03, 0, g);
    add(turn([[0, 0], [0.075, 0], [0.085, 0.06], [0.07, 0.13], [0.03, 0.155], [0, 0.16]]), paint(P.pink), 0, 0, 0, kettle);
    ball(0.016, paint(P.white), 0, 0.165, 0, kettle);
    const handle = add(new THREE.TorusGeometry(0.05, 0.009, 8, 24, Math.PI), paint(P.white), 0, 0.15, 0, kettle);
    handle.rotation.y = Math.PI / 2;
    cyl(0.008, 0.016, 0.09, paint(P.pink), 0, 0.09, 0.09, kettle).rotation.x = 0.9;
    // sink with a gold swan-neck tap
    const sx = -0.15;
    soft(0.5, 0.012, 0.38, 0.05, mat(0xb9c2ca, null, { metalness: 0.8, roughness: 0.3 }), sx, top + 0.002, 0.02, g);
    soft(0.42, 0.006, 0.3, 0.04, mat(0x6e7780, null, { metalness: 0.8, roughness: 0.35 }), sx, top + 0.008, 0.02, g);
    cyl(0.015, 0.018, 0.25, gold, sx, top + 0.125, -0.22, g);
    add(new THREE.TorusGeometry(0.07, 0.012, 10, 24, Math.PI), gold, sx, top + 0.25, -0.15, g).rotation.y = Math.PI / 2;
    // an open shelf above, with jars and plates
    const shelfY = 1.55;
    soft(L * 0.8, 0.03, 0.22, 0.01, paint(P.white), 0, shelfY, -dep / 2 + 0.11, g);
    [[P.pink, -0.5], [P.mint, -0.36], [P.butter, -0.22]].forEach(([c, x]) => {
      cyl(0.045, 0.045, 0.12, mat(0xfafcff, null, { roughness: 0.1 }), x, shelfY + 0.075, -dep / 2 + 0.11, g);
      cyl(0.048, 0.048, 0.025, paint(c), x, shelfY + 0.15, -dep / 2 + 0.11, g);
    });
    for (let i = 0; i < 4; i++) cyl(0.1, 0.08, 0.014, porcelain, 0.3, shelfY + 0.022 + i * 0.016, -dep / 2 + 0.12, g);
  }

  // ---------- fridge in the south-west corner: round-shouldered and pink ----------
  {
    const g = group(-W / 2 + 0.36, 0, V(0.885), Math.PI / 2);
    for (const sx of [-1, 1]) cyl(0.025, 0.025, 0.05, chrome, sx * 0.25, 0.025, 0.2, g);
    soft(0.66, 1.6, 0.64, 0.14, paint(0xf7b9c8), 0, 0.85, 0, g);
    box(0.62, 0.012, 0.012, paint(0xe8a3b5), 0, 1.17, 0.32, g);                                // where the two doors meet
    for (const [y, h] of [[1.42, 0.3], [0.8, 0.42]]) soft(0.035, h, 0.04, 0.015, chrome, 0.24, y, 0.34, g);
    flat(0.12, 0.03, mat(0xffffff, null, { metalness: 0.6, roughness: 0.3 }), 0, 1.5, 0.322, g);
    // magnets on the door: a heart and a strawberry-pink star
    const magnet = add(puffed(heartShape(0.06), 0.01, 0.006), paint(0xe96f8f), -0.12, 1.3, 0.335, g);
    const mag2 = add(puffed(starShape(0.035), 0.01, 0.005), paint(P.butter), -0.03, 1.36, 0.335, g);
    void magnet; void mag2;
  }

  // ---------- dining table: four places, four pastel chairs ----------
  function chair(x, z, rotY, color) {
    const g = group(x, 0, z, rotY), m = paint(color);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = cyl(0.018, 0.013, 0.44, oak, sx * 0.16, 0.22, sz * 0.16, g);
      leg.rotation.set(-sz * 0.06, 0, sx * 0.06);
    }
    soft(0.42, 0.05, 0.42, 0.02, m, 0, 0.465, 0, g);
    soft(0.36, 0.035, 0.36, 0.015, paint(P.cream), 0, 0.505, 0.01, g);                         // seat pad
    for (const sx of [-1, 1]) cyl(0.014, 0.014, 0.34, m, sx * 0.17, 0.66, -0.19, g).rotation.x = -0.12;
    const back = soft(0.42, 0.2, 0.04, 0.02, m, 0, 0.8, -0.215, g);
    back.rotation.x = -0.12;
  }
  {
    const cx = U(0.325), cz = V(0.685), tw = 0.9, td = 1.3, ty = 0.75;
    soft(tw, 0.045, td, 0.02, paint(P.white), cx, ty, cz);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(0.03, 0.018, ty - 0.02, oak, cx + sx * (tw / 2 - 0.08), (ty - 0.02) / 2, cz + sz * (td / 2 - 0.1));
    const places = [[-1, -1, P.pink], [-1, 1, P.mint], [1, -1, P.lilac], [1, 1, P.butter]];
    for (const [sx, sz, color] of places) {
      const px = cx + sx * 0.24, pz = cz + sz * 0.32;
      box(0.26, 0.004, 0.34, paint(color), px, ty + 0.025, pz);                                    // placemat
      add(turn([[0, 0], [0.07, 0], [0.11, 0.012], [0.115, 0.016], [0.1, 0.014], [0, 0.006]]), porcelain, px, ty + 0.027, pz);
      chair(cx + sx * 0.64, pz, sx < 0 ? Math.PI / 2 : -Math.PI / 2, color);
    }
    // a little vase of tulips in the middle
    const v = group(cx, ty + 0.023, cz);
    add(turn([[0, 0], [0.035, 0], [0.045, 0.05], [0.025, 0.11], [0.03, 0.13]]), mat(0xc6e2f5, null, { roughness: 0.15 }), 0, 0, 0, v);
    [[0.0, 0.32, 0x000000, 0xf47aa0], [0.05, 0.28, 0, 0xffd76a], [-0.045, 0.27, 0, 0xf7a8bd]].forEach(([dx, h, , c]) => {
      const st = cyl(0.004, 0.004, h - 0.1, leafGreen, dx / 2, 0.1 + (h - 0.1) / 2, 0, v);
      st.rotation.z = -dx * 2;
      ball(1, paint(c), dx, h, 0, v, 0.022, 0.032, 0.022);
    });
  }

  // ---------- the front door, with the "Hi" mat inside it ----------
  // Door and closet are built from inward-facing sheets, like the outer walls,
  // so from outside the cut-away they vanish along with the south wall.
  {
    const x = (FRONT_DOOR[0] + FRONT_DOOR[1]) / 2, w = FRONT_DOOR[1] - FRONT_DOOR[0], z = D / 2;
    const face = group(x, 0, z - 0.03, Math.PI);                       // local +z faces into the room
    flat(w - 0.04, DOOR_H - 0.02, paint(P.mint), 0, (DOOR_H - 0.02) / 2, 0, face);
    for (const y of [0.55, 1.45]) flat(w - 0.3, 0.6, paint(0xcdeee0), 0, y, 0.004, face);
    for (const s of [-1, 1]) flat(0.07, DOOR_H + 0.06, trim, s * (w / 2 + 0.035), (DOOR_H + 0.06) / 2, 0.012, face);
    flat(w + 0.21, 0.07, trim, 0, DOOR_H + 0.035, 0.012, face);
    ball(0.03, gold, w / 2 - 0.12, 1.0, 0.035, face);
    add(new THREE.ShapeGeometry(heartShape(0.22), 24), paint(0xf7a8bd), 0, 1.9, 0.008, face);   // flat, like the door
    const mat_ = add(new THREE.PlaneGeometry(0.78, 0.48), mat(0xffffff, hiTex, { roughness: 1 }), x, 0.012, z - 0.42);
    mat_.rotation.x = -Math.PI / 2;
    mat_.castShadow = false;
    soft(0.8, 0.01, 0.5, 0.004, mat(0xc7a676), x, 0.005, z - 0.42).castShadow = false;
    fluff([mat_], { length: 0.006, layers: 6, strand: 0.003, shade: 0.75, uvSize: [0.78, 0.48] });
  }

  // ---------- the closet built into the south wall ----------
  {
    const x0 = U(0.19), x1 = U(0.30), w = x1 - x0;
    const face = group((x0 + x1) / 2, 0, D / 2 - 0.004, Math.PI);
    flat(w + 0.12, 2.2, trim, 0, 1.1, 0, face);
    for (const s of [-1, 1]) {
      flat(w / 2 - 0.02, 2.06, paint(P.cream), s * w / 4, 1.08, 0.004, face);
      for (const y of [0.55, 1.5]) flat(w / 2 - 0.14, 0.7, paint(P.blush), s * w / 4, y, 0.008, face);
      ball(0.022, gold, s * 0.05, 1.05, 0.03, face);
    }
  }

  // ---------- bedroom: a loft bed over a desk, against the east wall ----------
  {
    const bx0 = 3.2, bx1 = W / 2 - 0.03, bz0 = -D / 2 + 0.08, bz1 = -0.93, plat = 1.45;
    const mx = (bx0 + bx1) / 2, mz = (bz0 + bz1) / 2, frame = paint(P.white);
    for (const x of [bx0 + 0.03, bx1 - 0.03]) for (const z of [bz0 + 0.03, bz1 - 0.03]) soft(0.06, 2.05, 0.06, 0.012, frame, x, 1.025, z);
    for (const x of [bx0 + 0.03, bx1 - 0.03]) soft(0.05, 0.12, bz1 - bz0, 0.01, frame, x, plat, mz);
    for (const z of [bz0 + 0.03, bz1 - 0.03]) soft(bx1 - bx0, 0.12, 0.05, 0.01, frame, mx, plat, z);
    box(bx1 - bx0 - 0.08, 0.03, bz1 - bz0 - 0.08, oak, mx, plat + 0.05, mz);
    slab(bx1 - bx0 - 0.1, 0.16, bz1 - bz0 - 0.1, 0.05, [cream, cream], mx, plat + 0.065, mz);
    const mattTop = plat + 0.225;
    // guard rails: the west side is left open at the ladder
    const railY = plat + 0.38;
    soft(0.04, 0.05, bz1 - bz0 - 0.5, 0.01, frame, bx0 + 0.03, railY, bz0 + (bz1 - bz0 - 0.5) / 2);
    for (const z of [bz0 + 0.03, bz1 - 0.03]) soft(bx1 - bx0, 0.05, 0.04, 0.01, frame, mx, railY, z);
    for (let z = bz0 + 0.3; z < bz1 - 0.5; z += 0.3) soft(0.03, railY - plat, 0.03, 0.008, frame, bx0 + 0.03, (railY + plat) / 2, z);
    // the ladder, at the south end, as drawn
    const lz0 = bz1 - 0.44, lz1 = bz1 - 0.06, lx = bx0 - 0.03;
    for (const z of [lz0, lz1]) soft(0.05, railY, 0.05, 0.01, frame, lx, railY / 2, z);
    for (let y = 0.3; y < plat; y += 0.3) soft(0.07, 0.04, lz1 - lz0, 0.01, oak, lx, y, (lz0 + lz1) / 2);
    // bedding: a plump pink duvet with hearts, a dotty pillow, and a plush rabbit
    const duvet = add(pillowGeo(bx1 - bx0 - 0.06, 1.42, 0.13), mat(0xffffff, duvetTex), mx, mattTop + 0.045, bz1 - 0.06 - 0.71);
    const pillow = add(pillowGeo(0.62, 0.4, 0.15), mat(0xffffff, dotsTex('#ffffff', '#f7b9c8', 2)), mx, mattTop + 0.06, bz0 + 0.3);
    fluff([duvet], { length: 0.006, layers: 6, strand: 0.0018, shade: 0.85, uvSize: [bx1 - bx0 - 0.06, 1.42] });
    fluff([pillow], { length: 0.006, layers: 6, strand: 0.0018, shade: 0.85, uvSize: [0.62, 0.4] });
    chickToy(mx - 0.08, mattTop + 0.07, bz0 + 0.66, -Math.PI / 2 + 0.35);
    // a floating shelf of books on the wall above the bed
    const shelfY = 2.22;
    soft(0.22, 0.03, 0.95, 0.008, paint(P.white), W / 2 - 0.11, shelfY, mz);
    let z = mz - 0.42;
    for (const [c, h, t] of [[P.pink, 0.21, 0.04], [P.lilac, 0.19, 0.03], [P.mint, 0.23, 0.045], [P.butter, 0.18, 0.03], [P.sky, 0.21, 0.035], [0xf7a8bd, 0.2, 0.04]]) {
      book(0.16, h, t, c, W / 2 - 0.11, shelfY + 0.015, z + t / 2, 0);
      z += t + 0.005;
    }
    const heartOnShelf = add(puffed(heartShape(0.1), 0.03, 0.015), paint(0xf47aa0), W / 2 - 0.11, shelfY + 0.065, mz + 0.2);
    heartOnShelf.rotation.y = -Math.PI / 2;

    // the desk underneath: three drawers, a plant in a wavy pot, a pencil cup, a desk lamp plugged into the wall
    const dx0 = W / 2 - 0.6, dz0 = -2.6, dz1 = -1.2, dTop = 0.75, dcx = (dx0 + W / 2) / 2, dcz = (dz0 + dz1) / 2;
    soft(0.6, 0.035, dz1 - dz0, 0.012, paint(P.white), dcx, dTop, dcz);
    soft(0.56, 0.13, dz1 - dz0 - 0.04, 0.012, paint(P.white), dcx, dTop - 0.085, dcz);
    for (let i = 0; i < 3; i++) {
      const z = dz0 + (i + 0.5) * (dz1 - dz0) / 3;
      soft(0.02, 0.1, (dz1 - dz0) / 3 - 0.04, 0.008, paint(P.lilac), dx0 - 0.002, dTop - 0.085, z);
      ball(0.014, gold, dx0 - 0.02, dTop - 0.085, z);
    }
    for (const x of [dx0 + 0.04, W / 2 - 0.04]) for (const z of [dz0 + 0.04, dz1 - 0.04]) cyl(0.02, 0.016, dTop - 0.02, paint(P.white), x, (dTop - 0.02) / 2, z);
    const surface = dTop + 0.018;
    potPlant(dcx + 0.08, surface, dz0 + 0.2, 0.07, 0.12, mat(0xffffff, wavyTex), 9, 0.2, 0.3);
    const cup = group(dcx + 0.1, surface, dz0 + 0.55);
    cyl(0.04, 0.036, 0.1, paint(P.mint), 0, 0.05, 0, cup);
    [[0xf7a8bd, 0.012, 0.012, 0.15], [0xfbe7a6, -0.012, 0.01, -0.1], [0xc6e2f5, 0, -0.014, 0.05], [0xd9c8f0, 0.016, -0.006, 0.2]].forEach(([c, x, z, lean]) => {
      const p = cyl(0.004, 0.004, 0.17, paint(c), x, 0.11, z, cup);
      p.rotation.set(lean, 0, -lean * 0.6);
    });
    // articulated lamp: base, two arms, a cone shade, all in pink
    const lampMat = paint(0xf7a8bd), deskLamp = group(dcx + 0.12, surface, dz1 - 0.3);
    cyl(0.06, 0.07, 0.02, lampMat, 0, 0.01, 0, deskLamp);
    const arm1 = cyl(0.009, 0.009, 0.3, lampMat, -0.05, 0.16, 0, deskLamp); arm1.rotation.z = 0.35;
    const arm2 = cyl(0.009, 0.009, 0.26, lampMat, -0.17, 0.33, 0, deskLamp); arm2.rotation.z = -1.0;
    ball(0.016, gold, -0.1, 0.3, 0, deskLamp);
    const deskShade = shadeMat(0xf7a8bd), deskBulb = bulbMat();
    const head = add(turn([[0.07, 0], [0.065, 0.02], [0.03, 0.08], [0.016, 0.09]], 32), deskShade, -0.29, 0.36, 0, deskLamp);
    head.rotation.z = 2.2;
    ball(0.022, deskBulb, -0.27, 0.33, 0, deskLamp);
    deskLamp.updateMatrixWorld(true);
    const glowAt = deskLamp.localToWorld(new THREE.Vector3(-0.27, 0.3, 0));
    lamp(glowAt.x, glowAt.y, glowAt.z, { hit: [0.2, surface + 0.5], shades: [deskShade], bulb: deskBulb, power: 0.5, distance: 2.5 });
    // its cable runs to a socket on the wall, as in the sketch
    const socketZ = dz1 + 0.12;
    flat(0.08, 0.08, paint(P.white), 0, 0, 0, group(W / 2 - 0.003, 0.35, socketZ, -Math.PI / 2));
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(dcx + 0.17, surface + 0.01, dz1 - 0.3), new THREE.Vector3(W / 2 - 0.03, surface + 0.01, dz1 - 0.2),
      new THREE.Vector3(W / 2 - 0.02, 0.6, dz1 - 0.02), new THREE.Vector3(W / 2 - 0.015, 0.38, socketZ),
    ]);
    add(new THREE.TubeGeometry(path, 40, 0.004, 6), paint(0xf7a8bd), 0, 0, 0);
  }

  // ---------- the rest of the bedroom ----------
  {
    // a standing lamp in the corner by the partition, lilac
    const g = group(1.45, 0, -D / 2 + 0.35);
    cyl(0.13, 0.15, 0.025, paint(P.white), 0, 0.012, 0, g);
    cyl(0.015, 0.015, 1.4, gold, 0, 0.72, 0, g);
    const floorShade = shadeMat(0xd9c8f0), floorBulb = bulbMat();
    add(new THREE.CylinderGeometry(0.17, 0.22, 0.28, 48, 1, true), floorShade, 0, 1.5, 0, g);
    ball(0.04, floorBulb, 0, 1.44, 0, g);
    lamp(1.45, 1.42, -D / 2 + 0.35, { hit: [0.24, 1.66], shades: [floorShade], bulb: floorBulb, power: 1.4 });
    // a plant in a spotty pot, by the bed
    potPlant(U(0.845), 0, -D / 2 + 0.34, 0.19, 0.34, mat(0xffffff, dotsTex('#ffffff', '#f4a6ba', 4, 2)), 15, 0.6, 0.22);
    // the print on the partition
    picture(printTex, 0.5, 0.65, 0.035, paint(P.pink), group(PX + T / 2 + 0.004, 1.55, V(0.23), Math.PI / 2));
    // a low dresser against the bathroom wall, a round mirror and a jewellery box on it
    const dw = U(0.79) - U(0.67);
    drawers(dw, 0.8, 0.45, 2, 2, (U(0.67) + U(0.79)) / 2, PZ - T / 2 - 0.235, Math.PI, paint(P.butter), paint(P.cream));
    const top = 0.8, mx = (U(0.67) + U(0.79)) / 2 + 0.22, mz = PZ - T / 2 - 0.25;
    cyl(0.05, 0.06, 0.015, gold, mx, top + 0.008, mz);
    cyl(0.008, 0.008, 0.12, gold, mx, top + 0.07, mz);
    const frame = add(new THREE.TorusGeometry(0.11, 0.012, 12, 40), gold, mx, top + 0.24, mz);
    void frame;
    add(new THREE.CircleGeometry(0.105, 40), mat(0xdfe6ee, null, { metalness: 1, roughness: 0.04 }), mx, top + 0.24, mz - 0.003).rotation.y = Math.PI;
    soft(0.16, 0.08, 0.11, 0.02, paint(0xf7a8bd), mx - 0.45, top + 0.04, mz);
    const lidHeart = add(puffed(heartShape(0.06), 0.01, 0.006), gold, mx - 0.45, top + 0.087, mz);
    lidHeart.rotation.x = -Math.PI / 2;
  }

  // ---------- bathroom ----------
  // mint-and-white tiles up the walls to shoulder height
  {
    const tileH = 1.25, wallTile = (len, x, z, rotY) => {
      const m = add(new THREE.PlaneGeometry(len, tileH), mat(0xffffff, tileTex(len / 0.6, tileH / 0.6), { roughness: 0.2 }), x, tileH / 2, z);
      m.rotation.y = rotY;
      m.castShadow = false;
    };
    wallTile(D / 2 - PZ - T / 2, W / 2 - 0.004, (PZ + T / 2 + D / 2) / 2, -Math.PI / 2);   // east wall
    wallTile(W / 2 - PX - T / 2, (PX + T / 2 + W / 2) / 2, D / 2 - 0.004, Math.PI);         // south wall
    wallTile(D / 2 - PZ - T / 2, PX + T / 2 + 0.004, (PZ + T / 2 + D / 2) / 2, Math.PI / 2); // partition, bath side
  }
  // a freestanding oval tub on gold feet, full of water and a few bubbles
  {
    const tx = PX + T / 2 + 0.47, tz = V(0.82), tw = 0.76, td = 1.5, r = 0.36, base = 0.08, rim = 0.58;
    const rounded = (w, d, rr) => {
      const s = new THREE.Shape(), a = -w / 2, b = -d / 2;
      s.moveTo(a + rr, b); s.lineTo(a + w - rr, b); s.quadraticCurveTo(a + w, b, a + w, b + rr);
      s.lineTo(a + w, b + d - rr); s.quadraticCurveTo(a + w, b + d, a + w - rr, b + d);
      s.lineTo(a + rr, b + d); s.quadraticCurveTo(a, b + d, a, b + d - rr);
      s.lineTo(a, b + rr); s.quadraticCurveTo(a, b, a + rr, b);
      return s;
    };
    const ring = rounded(tw, td, r);
    ring.holes.push(rounded(tw - 0.1, td - 0.1, r - 0.05));
    const shell = new THREE.ExtrudeGeometry(ring, { depth: rim - base, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3, curveSegments: 24 });
    shell.rotateX(-Math.PI / 2);
    add(shell, porcelain, tx, base, tz);
    slab(tw - 0.08, 0.03, td - 0.08, r - 0.04, [porcelain, porcelain], tx, base, tz);
    const water = add(new THREE.ShapeGeometry(rounded(tw - 0.1, td - 0.1, r - 0.05), 24), mat(0xbfe4ef, null, { roughness: 0.04, metalness: 0.1 }), tx, rim - 0.1, tz);
    water.rotation.x = -Math.PI / 2;
    water.castShadow = false;
    for (let i = 0; i < 26; i++) ball(0.02 + rand() * 0.03, mat(0xffffff, null, { roughness: 0.3 }), tx + (rand() - 0.5) * 0.5, rim - 0.1, tz + (rand() - 0.5) * 1.1, scene, 1, 0.6, 1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) ball(0.04, gold, tx + sx * (tw / 2 - 0.12), 0.04, tz + sz * (td / 2 - 0.2));
    // a gold floor-standing tap at the north end, arching over the rim
    const spout = new THREE.CatmullRomCurve3([
      new THREE.Vector3(tx, 0, tz - td / 2 - 0.07), new THREE.Vector3(tx, 0.8, tz - td / 2 - 0.07),
      new THREE.Vector3(tx, 0.86, tz - td / 2 + 0.02), new THREE.Vector3(tx, 0.74, tz - td / 2 + 0.12),
    ]);
    add(new THREE.TubeGeometry(spout, 40, 0.016, 10), gold, 0, 0, 0);
  }
  {
    // the fringed bath mat
    const top = add(new THREE.PlaneGeometry(0.9, 0.6), mat(0xffffff, dotsTex('#f7b9c8', '#fbd3dd', 3, 2), { roughness: 1 }), U(0.835), 0.006, V(0.765));
    top.rotation.x = -Math.PI / 2;
    top.castShadow = false;
    fluff([top], { length: 0.012, layers: 8, strand: 0.004, curl: 0.4, shade: 0.75, uvSize: [0.9, 0.6] });
  }
  {
    // pedestal basin on the east wall, a round gold mirror above it
    const x = W / 2 - 0.27, z = V(0.75);
    add(turn([[0.07, 0], [0.09, 0.02], [0.06, 0.4], [0.07, 0.68], [0.1, 0.72]], 32), porcelain, x, 0, z);
    add(turn([[0, 0.7], [0.12, 0.7], [0.2, 0.76], [0.24, 0.84], [0.25, 0.86], [0.22, 0.86], [0.18, 0.8], [0, 0.78]], 48), porcelain, x, 0, z);
    cyl(0.012, 0.014, 0.14, gold, x + 0.2, 0.92, z, scene);
    cyl(0.009, 0.009, 0.11, gold, x + 0.15, 0.98, z, scene).rotation.z = Math.PI / 2;
    const mirror = group(W / 2 - 0.006, 1.55, z, -Math.PI / 2);
    add(new THREE.TorusGeometry(0.27, 0.025, 14, 64), gold, 0, 0, 0.02, mirror);
    flat(0.5, 0.5, mat(0xdfe6ee, null, { metalness: 1, roughness: 0.04 }), 0, 0, 0.004, mirror).geometry = new THREE.CircleGeometry(0.265, 64);
  }
  {
    // the toilet in the south-east corner, facing west
    const g = group(W / 2 - 0.36, 0, V(0.92), -Math.PI / 2);
    add(turn([[0.11, 0], [0.13, 0.02], [0.12, 0.2], [0.17, 0.36], [0.19, 0.4], [0, 0.4]], 40), porcelain, 0, 0, 0.04, g).scale.z = 1.3;
    const seat = add(new THREE.TorusGeometry(0.15, 0.03, 12, 40), paint(P.pink), 0, 0.42, 0.06, g);
    seat.rotation.x = Math.PI / 2; seat.scale.y = 1.25;
    soft(0.4, 0.36, 0.16, 0.05, porcelain, 0, 0.62, -0.24, g);                                   // cistern
    ball(0.022, gold, 0.1, 0.81, -0.24, g);
  }
  {
    // the shower in the middle of the south wall: a tray, a glass screen, a rain head
    const x0 = U(0.775), x1 = U(0.875) + 0.05, z0 = V(0.855), z1 = D / 2 - 0.02;
    slab(x1 - x0, 0.06, z1 - z0, 0.04, [porcelain, porcelain], (x0 + x1) / 2, 0, (z0 + z1) / 2);
    cyl(0.03, 0.03, 0.004, chrome, (x0 + x1) / 2, 0.062, (z0 + z1) / 2);
    // a glass enclosure you can actually see: faintly aqua glass with a frosted band
    // across it, every edge framed in gold, fixed panels on three sides and a hinged door
    const glassTint = new THREE.MeshPhysicalMaterial({ color: 0xcdeeea, roughness: 0.08, transparent: true, opacity: 0.34, envMapIntensity: 2.5, side: THREE.DoubleSide, depthWrite: false });
    const frost = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
    const gh = 1.95, gy = 0.06 + gh / 2;
    const glassPanel = (w, cx, cz, rotY, parent) => {
      const g = group(cx, gy, cz, rotY, parent);
      for (const [geo, m, y] of [[new THREE.PlaneGeometry(w, gh), glassTint, 0], [new THREE.PlaneGeometry(w - 0.03, 0.3), frost, 0.08]]) {
        const pane = add(geo, m, 0, y, 0, g);
        pane.castShadow = false;
        hideFromAO.push(pane);
      }
      for (const sgn of [-1, 1]) {
        soft(0.022, gh, 0.022, 0.006, gold, sgn * w / 2, 0, 0, g);
        soft(w, 0.022, 0.022, 0.006, gold, 0, sgn * gh / 2, 0, g);
      }
      return g;
    };
    const doorW = 0.5;
    glassPanel(x1 - x0 - doorW, x0 + doorW + (x1 - x0 - doorW) / 2, z0, 0);            // facing the room, fixed
    glassPanel(z1 - z0, x0, (z0 + z1) / 2, Math.PI / 2);                               // the tub side
    glassPanel(z1 - z0, x1, (z0 + z1) / 2, Math.PI / 2);                               // the toilet side
    // the door, hinged at the corner and left a little open into the bathroom
    const hinge = group(x0, 0, z0, 0.45);
    glassPanel(doorW, doorW / 2, 0, 0, hinge);
    for (const sgn of [-1, 1]) soft(0.018, 0.32, 0.018, 0.006, gold, doorW - 0.07, gy, sgn * 0.035, hinge);   // handle, both sides
    cyl(0.012, 0.012, 2.0, chrome, (x0 + x1) / 2, 1.0, z1 - 0.04);
    cyl(0.12, 0.12, 0.02, chrome, (x0 + x1) / 2, 2.05, z1 - 0.18);
    cyl(0.01, 0.01, 0.15, chrome, (x0 + x1) / 2, 2.05, z1 - 0.1).rotation.x = Math.PI / 2;
    // a little caddy of pastel bottles
    soft(0.28, 0.02, 0.1, 0.006, chrome, x1 - 0.2, 1.1, z1 - 0.05);
    [[P.pink, 0.16], [P.mint, 0.13], [P.lilac, 0.18]].forEach(([c, h], i) => soft(0.06, h, 0.05, 0.02, paint(c), x1 - 0.29 + i * 0.08, 1.11 + h / 2, z1 - 0.05));
  }

  // Almost nothing in the room moves. Fold every mesh that shares a material into one
  // world-space mesh (hundreds of draw calls become a few dozen), then freeze
  // all transforms.
  scene.updateMatrixWorld(true);
  {
    const special = new Set(hideFromAO), buckets = new Map();
    scene.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || o.renderOrder !== 0 || windCurtains.includes(o)) return;
      for (let p = o; p; p = p.parent) if (special.has(p)) return;
      const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(o);
    });
    for (const meshes of buckets.values()) {
      if (meshes.length < 2) continue;
      const parts = meshes.map(m => {
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        return g.applyMatrix4(m.matrixWorld);
      });
      const merged = new THREE.Mesh(mergeGeometries(parts), meshes[0].material);
      merged.castShadow = meshes[0].castShadow;
      merged.receiveShadow = meshes[0].receiveShadow;
      scene.add(merged);
      meshes.forEach(m => m.removeFromParent());
      parts.forEach(g => g.dispose());
    }
  }
  scene.updateMatrixWorld(true);
  scene.traverse(o => { o.matrixAutoUpdate = false; });

  // The beams of light in the air are worked out in the pipeline by walking each
  // view ray through the room and asking, step by step, "can this point see the
  // sun?". That needs a depth picture of the room taken from the sun.
  const sunCam = new THREE.OrthographicCamera(sunBox.left, sunBox.right, sunBox.top, sunBox.bottom, sunBox.near, sunBox.far);
  const sunDepth = new THREE.WebGLRenderTarget(1024, 1024, { depthTexture: new THREE.DepthTexture(1024, 1024) });
  const solid = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const volumetric = {
    sunDepth: sunDepth.depthTexture,
    sunMatrix: new THREE.Matrix4(),
    sunDir,
    color: new THREE.Color(),
    density: 0.17,
    boxMin: new THREE.Vector3(-W / 2, 0, -D / 2 - DEEP),       // the home, including the window reveals
    boxMax: new THREE.Vector3(W / 2 + DEEP, H, D / 2),
  };
  function renderSunDepth() {
    sunCam.position.copy(sun.position);
    sunCam.lookAt(sun.target.position);
    sunCam.updateMatrixWorld(true);
    const hidden = [...hideFromAO, ...windCurtains], was = hidden.map(o => o.visible);
    const bg = scene.background, auto = renderer.autoClear;
    hidden.forEach(o => { o.visible = false; });               // glass and the view outside do not block light
    scene.overrideMaterial = solid;
    scene.background = null;
    renderer.setRenderTarget(sunDepth);
    renderer.clear();
    renderer.render(scene, sunCam);
    scene.overrideMaterial = null;
    scene.background = bg;
    hidden.forEach((o, i) => { o.visible = was[i]; });
    renderer.autoClear = false;                                // then the blowing curtains, with their motion
    for (const c of windCurtains) {
      const own = c.material;
      c.material = blownMask;
      renderer.render(c, sunCam);
      c.material = own;
    }
    renderer.autoClear = auto;
    renderer.setRenderTarget(null);
    volumetric.sunMatrix.multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);
  }

  // Put the sun where it is `minutes` after sunrise (negative = before) and set
  // every light, the sky and the beams to match. Colours are linear RGB.
  const { lerp, smoothstep: ramp, DEG2RAD } = THREE.MathUtils;
  const blend = (out, a, b, t) => out.setRGB(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
  const landBase = new THREE.Color(0x7a8348);
  function setSun(minutes) {
    const el = 0.183 * minutes, az = 1.5 + 0.17 * minutes;                     // degrees up, degrees south of east
    sunDir.set(Math.sin(az * DEG2RAD) * Math.cos(el * DEG2RAD), Math.sin(el * DEG2RAD), -Math.cos(az * DEG2RAD) * Math.cos(el * DEG2RAD));   // -z east, +x south
    const risen = ramp(el, 0, 0.7);                                            // how much of the disc is over the ridge
    const day = ramp(el, 0, 6), dawn = ramp(el, -0.3, 8);
    const power = risen * lerp(3, 11, ramp(el, 0.3, 6));

    blend(sun.color, [1, 0.10, 0.01], [1, 0.26, 0.05], day);                   // deep red, easing to orange
    sun.intensity = power;
    sun.position.copy(sunDir).multiplyScalar(8).add(sun.target.position);
    sun.updateMatrix();
    sun.updateMatrixWorld(true);
    skyFill.intensity = lerp(0.03, 0.1, dawn);
    for (const [light, full] of bounces) light.intensity = full * power / 11;
    scene.environmentIntensity = lerp(0.06, 0.3, dawn);

    blend(sky.uZenith.value, [0.004, 0.008, 0.03], [0.02, 0.04, 0.14], dawn);
    blend(sky.uHorizon.value, [0.09, 0.03, 0.03], [0.5, 0.23, 0.11], dawn);
    blend(sky.uGlow.value, [0.45, 0.07, 0.01], [1.2, 0.5, 0.18], dawn);
    blend(sky.uLand.value, [0.05, 0.05, 0.07], [0.42, 0.36, 0.3], dawn);
    blend(sky.uCloud.value, [0.07, 0.045, 0.06], [0.85, 0.6, 0.5], dawn);
    sky.uDisc.value = 30;
    ground.material.color.copy(landBase).multiply(sky.uLand.value);
    for (const [m, tint] of townMats) m.emissive.copy(tint).multiply(sky.uHorizon.value).multiplyScalar(0.9);

    blend(volumetric.color, [1, 0.2, 0.04], [1, 0.46, 0.17], day).multiplyScalar(power / 11);
    return { exposure: lerp(1.4, 1.0, ramp(el, 0, 4)), progress: ramp(minutes, SUNRISE.start, 35) };
  }
  // seconds of breeze so far, and how hard it is blowing (0..1); returns the current swell for the sound of it
  function setWind(seconds, strength) {
    wind.uTime.value = sky.uTime.value = seconds;                              // the clouds drift on the same clock
    wind.uWind.value = strength;
    return 0.55 + 0.45 * Math.sin(seconds * 0.6) * Math.sin(seconds * 0.23 + 1.3);
  }

  setSun(SUNRISE.start);
  renderSunDepth();

  return { hideFromAO, volumetric, setSun, setWind, renderSunDepth, lamps, setLamp };
}
