"use strict";

(() => {
  // =========================================================
  // Constants
  // =========================================================
  const DT = 1 / 120;          // fixed physics step (seconds)
  const GRAVITY = 1800;        // px / s^2
  const DAMP = 0.998;          // air drag per step
  const ITER = 8;              // constraint iterations per step
  const FRICTION = 0.08;       // tangential velocity removed per contact step
  const BOUNCE = 0.1;

  const WORLD_W = 2000;
  const BASE = 450;            // baseline ground height
  const BOTTOM = 4000;         // bottom of the ground polygon

  const SPEED = 180;           // walk speed px/s
  const STAND = 55;            // pelvis height above ground
  const CROUCH = 36;
  const JUMP_V = 660;
  const SLIP_ANGLE = (42 * Math.PI) / 180;
  const HARD_LANDING = 1000;   // px/s fall speed that knocks the character down

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // =========================================================
  // Ground types (from the "Ground Types" list)
  // =========================================================
  function rng(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  }

  function curve(x0, x1, fn, step = 16) {
    const pts = [];
    const n = Math.ceil((x1 - x0) / step);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([x0 + (x1 - x0) * t, fn(t)]);
    }
    return pts;
  }

  const GROUNDS = [
    {
      name: "Flat",
      desc: "Baseline flat ground — check idle balance and the walk cycle.",
      build: () => [[0, BASE], [WORLD_W, BASE]],
    },
    {
      name: "Gentle slope",
      desc: "A 12° climb and a 20° descent. Walking uphill is slightly slower.",
      build: () => [[0, BASE], [450, BASE], [1150, BASE - 150], [1450, BASE - 150], [1850, BASE], [WORLD_W, BASE]],
    },
    {
      name: "Steep slope",
      desc: "A 40° climb (slow going), then a 55° drop. Above 42° the character loses footing and slides.",
      build: () => [[0, BASE], [450, BASE], [760, BASE - 260], [1000, BASE - 260], [1180, BASE], [WORLD_W, BASE]],
    },
    {
      name: "Bumpy",
      desc: "Rough, uneven ground. Each foot searches for the surface before it lands.",
      build: () => {
        const r = rng(12345);
        const pts = [[0, BASE]];
        for (let x = 300; x <= 1800; x += 18) {
          const taper = clamp(Math.min(x - 300, 1800 - x) / 160, 0, 1);
          pts.push([x, BASE - taper * (6 + 7 * Math.sin(x * 0.021) + r() * 16)]);
        }
        pts.push([WORLD_W, BASE]);
        return pts;
      },
    },
    {
      name: "Stairs",
      desc: "Nine 24px steps up, a landing, then nine steps down.",
      build: () => {
        const pts = [[0, BASE]];
        let x = 450, y = BASE;
        pts.push([x, y]);
        for (let i = 0; i < 9; i++) { y -= 24; pts.push([x, y]); x += 48; pts.push([x, y]); }
        x += 160; pts.push([x, y]);
        for (let i = 0; i < 9; i++) { y += 24; pts.push([x, y]); x += 48; pts.push([x, y]); }
        pts.push([WORLD_W, y]);
        return pts;
      },
    },
    {
      name: "Step / ledge",
      desc: "A single 28px step up, then a 52px ledge to drop off.",
      build: () => [[0, BASE], [700, BASE], [700, BASE - 28], [1300, BASE - 28], [1300, BASE + 24], [WORLD_W, BASE + 24]],
    },
    {
      name: "Hill",
      desc: "A smooth rounded hill, up to about 36° at its steepest.",
      build: () => [[0, BASE], ...curve(500, 1500, (t) => BASE - 230 * (1 - Math.cos(2 * Math.PI * t)) / 2, 20), [WORLD_W, BASE]],
    },
    {
      name: "Valley",
      desc: "A smooth dip, up to about 34° on each side.",
      build: () => [[0, BASE], ...curve(500, 1500, (t) => BASE + 220 * (1 - Math.cos(2 * Math.PI * t)) / 2, 20), [WORLD_W, BASE]],
    },
    {
      name: "Bowl",
      desc: "A deep half-ellipse. The walls turn vertical near the rim — walk in, then try to get out.",
      build: () => {
        const pts = [[0, BASE]];
        const cx = 1000, rx = 380, d = 300, n = 64;
        for (let i = 0; i <= n; i++) {
          const a = Math.PI - (Math.PI * i) / n;
          pts.push([cx + rx * Math.cos(a), BASE + d * Math.sin(a)]);
        }
        pts.push([WORLD_W, BASE]);
        return pts;
      },
    },
    {
      name: "Gap / pit",
      desc: "A small gap you can jump, then a deep pit. A long fall knocks the character down.",
      build: () => [
        [0, BASE], [650, BASE], [650, BASE + 60], [715, BASE + 60], [715, BASE],
        [1150, BASE], [1150, BASE + 320], [1420, BASE + 320], [1420, BASE], [WORLD_W, BASE],
      ],
    },
  ];

  // =========================================================
  // Terrain geometry
  // =========================================================
  let terrain = null;
  let groundIndex = 0;

  function makeTerrain(def) {
    const raw = def.build();
    const pts = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      segs.push({
        ax, ay, bx, by, dx, dy, len2: len * len,
        nx: dy / len, ny: -dx / len, // outward normal (points into the air)
        minx: Math.min(ax, bx), maxx: Math.max(ax, bx),
        miny: Math.min(ay, by), maxy: Math.max(ay, by),
        vertical: Math.abs(dx) < 0.5,
      });
    }
    const poly = [...pts, [WORLD_W, BOTTOM], [0, BOTTOM]];
    const minY = Math.min(...pts.map((p) => p[1]));
    return { pts, segs, poly, minY };
  }

  function insideGround(x, y) {
    const p = terrain.poly;
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  const hit = { x: 0, y: 0, d2: 0, seg: null };
  function closestOnGround(x, y) {
    let best = Infinity;
    for (const s of terrain.segs) {
      const ex = x < s.minx ? s.minx - x : x > s.maxx ? x - s.maxx : 0;
      const ey = y < s.miny ? s.miny - y : y > s.maxy ? y - s.maxy : 0;
      if (ex * ex + ey * ey >= best) continue;
      let t = ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.ax + s.dx * t, cy = s.ay + s.dy * t;
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 < best) { best = d2; hit.x = cx; hit.y = cy; hit.seg = s; }
    }
    hit.d2 = best;
    return hit;
  }

  // First ground surface straight below (x, fromY)
  function groundAt(x, fromY) {
    let best = Infinity, seg = null;
    for (const s of terrain.segs) {
      if (s.vertical || x < s.minx || x > s.maxx) continue;
      const y = s.ay + ((x - s.ax) / s.dx) * s.dy;
      if (y >= fromY && y < best) { best = y; seg = s; }
    }
    return seg ? { y: best, seg } : null;
  }

  // =========================================================
  // Ragdoll body
  // =========================================================
  // name: [x, y, radius] relative to the pelvis, standing and facing right
  const TEMPLATE = {
    head:   [0, -58, 11],
    neck:   [0, -40, 5],
    pelvis: [0, 0, 6],
    kneeB:  [3, 29.8, 4.5],
    footB:  [0, 59.6, 4.5],
    kneeF:  [5, 29.6, 4.5],
    footF:  [0, 59.2, 4.5],
    elbowB: [-1, -21, 4],
    handB:  [1, -2, 4],
    elbowF: [2, -21, 4],
    handF:  [3, -2, 4],
  };
  const STICKS = [
    ["head", "neck"], ["neck", "pelvis"],
    ["pelvis", "kneeB"], ["kneeB", "footB"],
    ["pelvis", "kneeF"], ["kneeF", "footF"],
    ["neck", "elbowB"], ["elbowB", "handB"],
    ["neck", "elbowF"], ["elbowF", "handF"],
  ];
  const SOFT = [["head", "pelvis", 0.5]];                     // keeps the spine from folding flat
  const MIN_DIST = [["pelvis", "footB", 26], ["pelvis", "footF", 26], ["neck", "handB", 14], ["neck", "handF", 14]];

  let ch = null;
  const input = { left: false, right: false, crouch: false };
  let drag = null;
  let debug = false;

  function spawn() {
    const sx = 200;
    const g = groundAt(sx, -1e5);
    const baseY = g.y - 59.6 - 4.5 - 1;
    const P = {};
    const list = [];
    for (const [name, [x, y, r]] of Object.entries(TEMPLATE)) {
      const p = { name, x: sx + x, y: baseY + y, px: sx + x, py: baseY + y, r, ax: 0, ay: 0, contact: false, knee: name.startsWith("knee") };
      P[name] = p;
      list.push(p);
    }
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const sticks = [
      ...STICKS.map(([a, b]) => ({ a: P[a], b: P[b], len: dist(P[a], P[b]), k: 1, leg: a === "pelvis" && b.startsWith("knee") })),
      ...SOFT.map(([a, b, k]) => ({ a: P[a], b: P[b], len: dist(P[a], P[b]), k })),
      ...MIN_DIST.map(([a, b, m]) => ({ a: P[a], b: P[b], len: m, k: 1, min: true, leg: a === "pelvis" })),
    ];
    const foot = (p) => ({ p, mode: "free", sx: 0, sy: 0, tx: p.x, ty: p.y, dx: p.x, dy: p.y, t: 0, dur: 0.2, lift: 0 });
    ch = {
      P, list, sticks,
      feet: [foot(P.footB), foot(P.footF)],
      upper: [P.pelvis, P.neck, P.head, P.elbowB, P.handB, P.elbowF, P.handF],
      mode: "active", limp: ch ? ch.limp : false,
      strength: 1, timer: 0, facing: 1,
      grounded: true, wasGrounded: true, airLock: 0, fallV: 0,
      slope: 0, slipping: false, ground: null, vx: 0, sinceStep: 0,
    };
    drag = null;
    snapCamera();
  }

  const controlActive = () => ch.mode === "active" && !ch.limp;

  function freeFeet() {
    for (const f of ch.feet) f.mode = "free";
  }

  function knock(t) {
    if (ch.mode === "dragged") return;
    ch.timer = ch.mode === "knocked" ? Math.max(ch.timer, t) : t;
    ch.mode = "knocked";
    ch.strength = 0;
    freeFeet();
  }

  // Damped spring that adds acceleration to a particle (optionally relative to another)
  function spring(p, tx, ty, k, c, ref, gravityCancel) {
    const rvx = ref ? (ref.x - ref.px) / DT : 0;
    const rvy = ref ? (ref.y - ref.py) / DT : 0;
    const vx = (p.x - p.px) / DT - rvx;
    const vy = (p.y - p.py) / DT - rvy;
    p.ax += k * (tx - p.x) - c * vx;
    p.ay += k * (ty - p.y) - c * vy - GRAVITY * (gravityCancel || 0);
  }

  // =========================================================
  // Active control: balance, movement, procedural feet
  // =========================================================
  function control() {
    const P = ch.P, pel = P.pelvis;
    const vx = (pel.x - pel.px) / DT;
    const vy = (pel.y - pel.py) / DT;
    ch.vx = vx;
    const inputX = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    if (ch.mode === "knocked") {
      ch.timer -= DT;
      if (ch.timer <= 0) ch.mode = "active";
    }
    if (ch.airLock > 0) ch.airLock -= DT;

    const active = controlActive();
    ch.strength = active ? Math.min(1, ch.strength + DT / 0.8) : 0;
    const s = ch.strength;
    if (active && inputX) ch.facing = inputX;

    // Probe the ground under the pelvis
    const g = groundAt(pel.x, pel.y - 12);
    ch.ground = g;
    ch.grounded = !!g && g.y - pel.y < 72 && ch.airLock <= 0;
    ch.slope = g ? Math.acos(clamp(-g.seg.ny, -1, 1)) : 0;
    ch.slipping = ch.grounded && ch.slope > SLIP_ANGLE;
    const downhill = g ? Math.sign(g.seg.nx) : 0;

    // Hard landings knock the character over
    if (!ch.grounded) ch.fallV = Math.max(ch.fallV, vy);
    else {
      if (!ch.wasGrounded && active && ch.fallV > HARD_LANDING) knock(1.4);
      ch.fallV = 0;
    }
    ch.wasGrounded = ch.grounded;

    if (!controlActive()) { freeFeet(); return; }

    const crouch = input.crouch;
    let tvx = inputX * SPEED * (crouch ? 0.5 : 1);
    const lean = clamp(vx / SPEED, -1, 1) * 0.06;
    const ux = Math.sin(lean), uy = -Math.cos(lean);

    if (ch.grounded) {
      // Uphill is slower; above the slip angle it is almost impossible
      if (inputX && inputX === -downhill && ch.slope > 0.05) {
        tvx *= ch.slipping ? 0.15 : Math.max(0.4, Math.cos(ch.slope) ** 2);
      }
      const support = s * (ch.slipping ? 0.55 : 1);
      const standH = crouch ? CROUCH : STAND;
      pel.ay += support * (900 * (g.y - standH - pel.y) - 50 * vy) - support * GRAVITY * 6;
      // Drive the whole upper body, not just the hips
      const drive = s * (tvx - vx) * 22;
      for (const p of ch.upper) p.ax += drive;
      if (ch.slipping) pel.ax += downhill * 1100 * Math.sin(ch.slope);

      // Keep the torso and head upright above the pelvis
      spring(P.neck, pel.x + ux * 40, pel.y + uy * 40, 900 * s, 40 * s, pel, s);
      spring(P.head, pel.x + ux * 58, pel.y + uy * 58, 900 * s, 40 * s, pel, s);

      // Arms swing opposite to the legs
      spring(P.handB, pel.x + ch.facing * 4 - (P.footB.x - pel.x) * 0.7, pel.y - 4, 60 * s, 6 * s, pel, 0);
      spring(P.handF, pel.x + ch.facing * 7 - (P.footF.x - pel.x) * 0.7, pel.y - 4, 60 * s, 6 * s, pel, 0);

      planFeet(vx, inputX);
    } else {
      // In the air: weak balance, a bit of air control, legs reach for the ground
      const airDrive = s * (tvx - vx) * 2.5;
      for (const p of ch.upper) p.ax += airDrive;
      spring(P.neck, pel.x + ux * 40, pel.y + uy * 40, 360 * s, 16 * s, pel, 0.4 * s);
      spring(P.head, pel.x + ux * 58, pel.y + uy * 58, 360 * s, 16 * s, pel, 0.4 * s);
      freeFeet();
      spring(P.footB, pel.x - 10 * ch.facing, pel.y + 50, 220 * s, 12 * s, pel, 0);
      spring(P.footF, pel.x + 12 * ch.facing, pel.y + 46, 220 * s, 12 * s, pel, 0);
    }

    // Knees act like hinges: only push a knee when it starts bending the wrong way
    kneeHinge(P.kneeB, P.footB, s);
    kneeHinge(P.kneeF, P.footF, s);
  }

  function kneeHinge(knee, foot, s) {
    const pel = ch.P.pelvis;
    const lx = foot.x - pel.x, ly = foot.y - pel.y;
    const len = Math.hypot(lx, ly) || 1;
    const fx = (ly / len) * ch.facing, fy = (-lx / len) * ch.facing; // "forward" side of the leg
    const side = (knee.x - pel.x) * fx + (knee.y - pel.y) * fy;
    if (side < 6) {
      const push = (6 - side) * 900 * s;
      knee.ax += fx * push;
      knee.ay += fy * push;
    }
  }

  function idleOffset(i) {
    return (i === 0 ? -9 : 9) * ch.facing;
  }

  function tryStep(f, x, dur) {
    const pel = ch.P.pelvis;
    const ok = (g) => g && g.y - pel.y < 85 && g.y > pel.y - 4;
    let g = groundAt(x, pel.y - 30);
    if (!ok(g)) {
      x = (x + pel.x) / 2;
      g = groundAt(x, pel.y - 30);
      if (!ok(g)) return false;
    }
    f.sx = f.p.x; f.sy = f.p.y;
    f.tx = x; f.ty = g.y - f.p.r;
    f.dx = f.sx; f.dy = f.sy;
    f.t = 0; f.dur = dur;
    ch.sinceStep = 0;
    f.lift = 8 + Math.max(0, f.sy - f.ty) * 0.7;
    f.mode = "stepping";
    return true;
  }

  function planFeet(vx, inputX) {
    const pel = ch.P.pelvis;
    const feet = ch.feet;
    // Walking steps only when the player is walking (or the body is really sliding);
    // otherwise the feet settle back under the hips and the character stops.
    const moving = inputX !== 0 || Math.abs(vx) > 90;
    const dir = inputX || Math.sign(vx) || ch.facing;
    ch.sinceStep += DT;

    for (const f of feet) {
      if (f.mode === "stepping") {
        f.t = Math.min(1, f.t + DT / f.dur);
        const e = f.t * f.t * (3 - 2 * f.t);
        f.dx = f.sx + (f.tx - f.sx) * e;
        f.dy = f.sy + (f.ty - f.sy) * e - Math.sin(Math.PI * f.t) * f.lift;
        if (f.t >= 1) f.mode = "planted";
      } else if (f.mode === "planted") {
        if (ch.slipping) { f.tx = f.p.x; f.ty = f.p.y; }
        f.dx = f.tx; f.dy = f.ty;
        if (Math.hypot(f.tx - pel.x, f.ty - pel.y) > 66 || Math.abs(f.tx - pel.x) > 42) f.mode = "free";
      }
    }

    // One step at a time
    if (feet.some((f) => f.mode === "stepping")) return;

    const freeIdx = feet.findIndex((f) => f.mode === "free");
    if (freeIdx >= 0) {
      tryStep(feet[freeIdx], pel.x + (moving ? dir * 12 : idleOffset(freeIdx)), 0.12);
      return;
    }

    let cand = null, worst = 0, targetX = 0;
    if (moving) {
      const lead = 8 + Math.min(Math.abs(vx), SPEED) * 0.07;
      for (const f of feet) {
        const behind = (pel.x - f.tx) * dir;
        if (behind > worst || !cand) { worst = behind; cand = f; }
      }
      // step when the rear foot falls behind, or keep marching if the body is held back
      if (cand && !(worst > 16 || (inputX && ch.sinceStep > 0.22 && Math.abs(vx) < 60))) cand = null;
      targetX = pel.x + dir * lead;
      if (cand) tryStep(cand, targetX, clamp(0.26 - Math.abs(vx) / 1500, 0.13, 0.24));
    } else {
      feet.forEach((f, i) => {
        const spot = pel.x + idleOffset(i);
        const err = Math.abs(f.tx - spot);
        if (err > 11 && err > worst) { worst = err; cand = f; targetX = spot; }
      });
      if (cand) tryStep(cand, targetX, 0.18);
    }
  }

  function pinFeet() {
    if (!controlActive() || !ch.grounded) return;
    const s = ch.strength;
    for (const f of ch.feet) {
      if (f.mode === "free") continue;
      const k = (f.mode === "planted" ? 0.85 : 0.6) * s * (ch.slipping ? 0.2 : 1);
      f.p.x += (f.dx - f.p.x) * k;
      f.p.y += (f.dy - f.p.y) * k;
    }
  }

  // =========================================================
  // Physics step (Verlet)
  // =========================================================
  // While balancing, the legs are IK: the hips move the legs, but the legs don't shove the hips
  let legsIK = false;
  function solveStick(c) {
    const a = c.a, b = c.b;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (c.min && d >= c.len) return;
    const diff = ((d - c.len) / d) * c.k;
    const wa = c.leg && legsIK ? 0 : 0.5;
    const wb = 1 - wa;
    a.x += dx * diff * wa; a.y += dy * diff * wa;
    b.x -= dx * diff * wb; b.y -= dy * diff * wb;
  }

  function collide(p, final) {
    // While the legs are under control, knees act as IK joints and don't snag on terrain
    if (p.knee && controlActive() && ch.grounded) return;
    if (p.x < p.r) p.x = p.r;
    else if (p.x > WORLD_W - p.r) p.x = WORLD_W - p.r;
    if (p.y + p.r + 1 < terrain.minY) return;

    const isIn = insideGround(p.x, p.y);
    closestOnGround(p.x, p.y);
    const d = Math.sqrt(hit.d2);
    const slop = final ? 0.75 : 0;
    if (!isIn && d >= p.r + slop) return;

    let nx, ny;
    if (d > 1e-4) {
      nx = (p.x - hit.x) / d; ny = (p.y - hit.y) / d;
      if (isIn) { nx = -nx; ny = -ny; }
    } else {
      nx = hit.seg.nx; ny = hit.seg.ny;
    }
    if (isIn || d < p.r) { p.x = hit.x + nx * p.r; p.y = hit.y + ny * p.r; }
    if (!final) return;

    // Contact response: friction + small bounce
    p.contact = true;
    const vx = p.x - p.px, vy = p.y - p.py;
    const vn = vx * nx + vy * ny;
    const tx = vx - vn * nx, ty = vy - vn * ny;
    const nvn = vn < 0 ? -vn * BOUNCE : vn;
    p.px = p.x - (tx * (1 - FRICTION) + nvn * nx);
    p.py = p.y - (ty * (1 - FRICTION) + nvn * ny);
  }

  function step() {
    control();

    const L = ch.list;
    for (const p of L) {
      const vx = (p.x - p.px) * DAMP, vy = (p.y - p.py) * DAMP;
      p.px = p.x; p.py = p.y;
      p.x += vx + p.ax * DT * DT;
      p.y += vy + (p.ay + GRAVITY) * DT * DT;
      p.ax = 0; p.ay = 0;
    }

    legsIK = controlActive() && ch.grounded;
    for (let it = 0; it < ITER; it++) {
      for (const c of ch.sticks) solveStick(c);
      if (drag) {
        drag.p.x += (drag.x - drag.p.x) * 0.5;
        drag.p.y += (drag.y - drag.p.y) * 0.5;
      }
      pinFeet();
      for (const p of L) collide(p, false);
    }

    for (const p of L) { p.contact = false; collide(p, true); }

    // Planted feet don't slide
    if (controlActive() && ch.grounded && !ch.slipping) {
      for (const f of ch.feet) if (f.mode === "planted") { f.p.px = f.p.x; f.p.py = f.p.y; }
    }

    // Head hits the ground -> fall over
    const P = ch.P;
    if (controlActive() && ch.strength > 0.6 && ch.airLock <= 0 && (P.head.contact || P.neck.contact)) knock(1.6);

    if (!Number.isFinite(P.pelvis.x) || !Number.isFinite(P.pelvis.y)) spawn();
  }

  // =========================================================
  // Actions
  // =========================================================
  function jump() {
    if (!controlActive() || !ch.grounded || ch.strength < 0.8) return;
    const v = input.crouch ? JUMP_V * 1.15 : JUMP_V;
    for (const p of ch.list) p.py = p.y + v * DT;
    ch.airLock = 0.25;
    freeFeet();
  }

  function shove() {
    if (ch.mode === "dragged") return;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const P = ch.P;
    for (const [p, f] of [[P.head, 750], [P.neck, 650], [P.pelvis, 250]]) {
      p.px = p.x - dir * f * DT;
      p.py = p.y + 180 * DT;
    }
    knock(1.4);
  }

  function setRagdoll(on) {
    ch.limp = on;
    if (!on && ch.mode === "active") ch.strength = 0;
    const b = document.getElementById("btn-ragdoll");
    b.textContent = `Ragdoll: ${on ? "on" : "off"}`;
    b.classList.toggle("on", on);
  }

  function setDebug(on) {
    debug = on;
    const b = document.getElementById("btn-debug");
    b.textContent = `Debug: ${on ? "on" : "off"}`;
    b.classList.toggle("on", on);
  }

  function setGround(i) {
    groundIndex = (i + GROUNDS.length) % GROUNDS.length;
    terrain = makeTerrain(GROUNDS[groundIndex]);
    document.querySelectorAll(".pill").forEach((p, j) => p.classList.toggle("active", j === groundIndex));
    document.getElementById("ground-desc").textContent = GROUNDS[groundIndex].desc;
    spawn();
  }

  const ACTIONS = {
    jump,
    shove,
    reset: () => spawn(),
    ragdoll: () => setRagdoll(!ch.limp),
    debug: () => setDebug(!debug),
  };

  // =========================================================
  // Rendering
  // =========================================================
  const canvas = document.getElementById("view");
  const ctx = canvas.getContext("2d");
  const cam = { x: 0, y: 0 };
  let scale = 1, viewW = 1000, VIEW_H = 560; // world units visible vertically (smaller = zoomed in)

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    VIEW_H = canvas.clientWidth < 640 ? 400 : 560;
    scale = canvas.clientHeight / VIEW_H;
    viewW = canvas.clientWidth / scale;
  }

  function camTarget() {
    const pel = ch.P.pelvis;
    let x = pel.x - viewW / 2;
    x = viewW >= WORLD_W ? (WORLD_W - viewW) / 2 : clamp(x, 0, WORLD_W - viewW);
    return { x, y: pel.y - VIEW_H * 0.58 };
  }
  function snapCamera() {
    if (!ch) return;
    const t = camTarget();
    cam.x = t.x; cam.y = t.y;
  }
  function updateCamera(dt) {
    const t = camTarget();
    const k = 1 - Math.exp(-dt * 5);
    cam.x += (t.x - cam.x) * k;
    cam.y += (t.y - cam.y) * k;
  }

  const COLORS = {
    active:  { front: "#7aa2ff", back: "#4767c4", body: "#6690f5" },
    knocked: { front: "#ffcf5c", back: "#c4972c", body: "#efbb46" },
    limp:    { front: "#a6aec0", back: "#6b7285", body: "#8b93a6" },
    dragged: { front: "#3ecf8e", back: "#278f60", body: "#34b47b" },
  };

  function strokePath(pts, w, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function drawFoot(p, color) {
    strokePath([p, { x: p.x + ch.facing * 7, y: p.y + 1 }], 6, color);
  }

  function drawCharacter() {
    const P = ch.P;
    const key = ch.mode === "dragged" ? "dragged" : ch.limp ? "limp" : ch.mode === "knocked" ? "knocked" : "active";
    const C = COLORS[key];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // back limbs
    strokePath([P.neck, P.elbowB, P.handB], 6, C.back);
    strokePath([P.pelvis, P.kneeB, P.footB], 8, C.back);
    drawFoot(P.footB, C.back);

    // torso + neck
    strokePath([P.neck, P.pelvis], 13, C.body);
    strokePath([P.neck, P.head], 6, C.body);

    // front leg
    strokePath([P.pelvis, P.kneeF, P.footF], 8, C.front);
    drawFoot(P.footF, C.front);

    // head
    ctx.fillStyle = C.front;
    ctx.beginPath();
    ctx.arc(P.head.x, P.head.y, P.head.r, 0, Math.PI * 2);
    ctx.fill();

    // eye
    let ux = P.head.x - P.neck.x, uy = P.head.y - P.neck.y;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;
    const ex = P.head.x - uy * ch.facing * 4.5 + ux * 1.5;
    const ey = P.head.y + ux * ch.facing * 4.5 + uy * 1.5;
    ctx.strokeStyle = "#0e1117";
    ctx.fillStyle = "#0e1117";
    if (key === "knocked") {
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(ex - 2.2, ey - 2.2); ctx.lineTo(ex + 2.2, ey + 2.2);
      ctx.moveTo(ex + 2.2, ey - 2.2); ctx.lineTo(ex - 2.2, ey + 2.2);
      ctx.stroke();
    } else if (key === "limp") {
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(ex - 2.4, ey); ctx.lineTo(ex + 2.4, ey); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI * 2); ctx.fill();
    }

    // front arm
    strokePath([P.neck, P.elbowF, P.handF], 6, C.front);
  }

  function drawDebug() {
    const P = ch.P, pel = P.pelvis;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    for (const c of ch.sticks) {
      if (c.min) continue;
      ctx.moveTo(c.a.x, c.a.y); ctx.lineTo(c.b.x, c.b.y);
    }
    ctx.stroke();
    for (const p of ch.list) {
      ctx.strokeStyle = p.contact ? "#ff6b6b" : "rgba(255,255,255,0.7)";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke();
    }
    // ground probe + normal
    if (ch.ground) {
      ctx.strokeStyle = ch.grounded ? "#3ecf8e" : "rgba(255,255,255,0.3)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pel.x, pel.y); ctx.lineTo(pel.x, ch.ground.y); ctx.stroke();
      ctx.setLineDash([]);
      const s = ch.ground.seg;
      ctx.strokeStyle = ch.slipping ? "#ff6b6b" : "#ffcf5c";
      ctx.beginPath(); ctx.moveTo(pel.x, ch.ground.y); ctx.lineTo(pel.x + s.nx * 30, ch.ground.y + s.ny * 30); ctx.stroke();
      ctx.fillStyle = "#3ecf8e";
      ctx.beginPath(); ctx.arc(pel.x, ch.ground.y - STAND, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    // foot targets
    for (const f of ch.feet) {
      if (f.mode === "free") continue;
      ctx.strokeStyle = f.mode === "planted" ? "#3ecf8e" : "#ffcf5c";
      ctx.beginPath();
      ctx.moveTo(f.tx - 5, f.ty - 5); ctx.lineTo(f.tx + 5, f.ty + 5);
      ctx.moveTo(f.tx + 5, f.ty - 5); ctx.lineTo(f.tx - 5, f.ty + 5);
      ctx.stroke();
    }
  }

  function render() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = canvas.width / (w || 1);

    // Background
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#151b2a");
    sky.addColorStop(1, "#0b0e15");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // World transform
    const k = dpr * scale;
    ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    const x0 = cam.x, x1 = cam.x + viewW, y0 = cam.y, y1 = cam.y + VIEW_H;

    // Grid
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.beginPath();
    for (let x = Math.floor(x0 / 50) * 50; x <= x1; x += 50) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = Math.floor(y0 / 50) * 50; y <= y1; y += 50) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();

    // Outside the world
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    if (x0 < 0) ctx.fillRect(x0, y0, -x0, VIEW_H);
    if (x1 > WORLD_W) ctx.fillRect(WORLD_W, y0, x1 - WORLD_W, VIEW_H);

    // Ground fill
    const pts = terrain.pts;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(WORLD_W, y1 + 200);
    ctx.lineTo(0, y1 + 200);
    ctx.closePath();
    const gg = ctx.createLinearGradient(0, terrain.minY, 0, terrain.minY + 520);
    gg.addColorStop(0, "#26304a");
    gg.addColorStop(1, "#11151f");
    ctx.fillStyle = gg;
    ctx.fill();

    // Character shadow
    const pel = ch.P.pelvis;
    const sg = groundAt(pel.x, pel.y - 12);
    if (sg) {
      const a = clamp(0.5 - (sg.y - pel.y - 50) / 400, 0.08, 0.5);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.beginPath();
      ctx.ellipse(pel.x, sg.y, 24, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ground surface line
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#5b8cff";
    ctx.stroke();

    drawCharacter();
    if (debug) drawDebug();
  }

  // =========================================================
  // HUD
  // =========================================================
  const hudState = document.getElementById("hud-state");
  const hudSpeed = document.getElementById("hud-speed");
  const hudSlope = document.getElementById("hud-slope");
  const hint = document.getElementById("hint");
  let lastHud = "";

  function stateLabel() {
    if (ch.mode === "dragged") return ["Grabbed", "grab"];
    if (ch.limp) return ["Ragdoll", "limp"];
    if (ch.mode === "knocked") return ["Knocked down", "knock"];
    if (ch.strength < 1) return ["Getting up", "knock"];
    if (!ch.grounded) return ["Airborne", "air"];
    if (ch.slipping) return ["Slipping", "knock"];
    const moving = Math.abs(ch.vx) > 30;
    if (input.crouch) return [moving ? "Crouch-walking" : "Crouching", "ok"];
    return [moving ? "Walking" : "Standing", "ok"];
  }

  function updateHUD() {
    const [label, cls] = stateLabel();
    const speed = String(Math.round(Math.abs(ch.vx) / 5) * 5);
    const slope = `${Math.round((ch.slope * 180) / Math.PI)}°`;
    const sig = label + speed + slope;
    if (sig !== lastHud) {
      lastHud = sig;
      hudState.textContent = label;
      hudState.className = `chip ${cls}`;
      hudSpeed.textContent = speed;
      hudSlope.textContent = slope;
    }
    hint.hidden = !(ch.P.pelvis.y > BASE + 150);
  }

  // =========================================================
  // Input: keyboard, on-screen buttons, mouse / touch drag
  // =========================================================
  const KEYMAP = {
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    ArrowDown: "crouch", KeyS: "crouch",
  };

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "BUTTON" && (e.code === "Space" || e.code === "Enter")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const hold = KEYMAP[e.code];
    if (hold) { input[hold] = true; e.preventDefault(); return; }
    if (e.repeat) return;
    switch (e.code) {
      case "ArrowUp": case "KeyW": case "Space": jump(); e.preventDefault(); break;
      case "KeyF": ACTIONS.ragdoll(); break;
      case "KeyE": shove(); break;
      case "KeyR": spawn(); break;
      case "KeyG": ACTIONS.debug(); break;
      default: {
        const m = /^Digit(\d)$/.exec(e.code);
        if (m) setGround(m[1] === "0" ? 9 : Number(m[1]) - 1);
      }
    }
  });
  window.addEventListener("keyup", (e) => {
    const hold = KEYMAP[e.code];
    if (hold) input[hold] = false;
  });
  window.addEventListener("blur", () => { input.left = input.right = input.crouch = false; });

  // On-screen hold buttons
  document.querySelectorAll("[data-hold]").forEach((btn) => {
    const key = btn.dataset.hold;
    const on = (e) => { e.preventDefault(); input[key] = true; btn.classList.add("pressed"); btn.setPointerCapture?.(e.pointerId); };
    const off = () => { input[key] = false; btn.classList.remove("pressed"); };
    btn.addEventListener("pointerdown", on);
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointercancel", off);
    btn.addEventListener("lostpointercapture", off);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });

  // On-screen action buttons
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => e.preventDefault()); // don't steal keyboard focus
    btn.addEventListener("click", () => ACTIONS[btn.dataset.action]());
  });

  // Drag the ragdoll
  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale + cam.x, y: (e.clientY - r.top) / scale + cam.y };
  }
  canvas.addEventListener("pointerdown", (e) => {
    const w = toWorld(e);
    let best = null, bd = 40 * 40;
    for (const p of ch.list) {
      const d2 = (p.x - w.x) ** 2 + (p.y - w.y) ** 2;
      if (d2 < bd) { bd = d2; best = p; }
    }
    if (!best) return;
    drag = { p: best, x: w.x, y: w.y };
    ch.mode = "dragged";
    ch.strength = 0;
    freeFeet();
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("grabbing");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const w = toWorld(e);
    drag.x = w.x; drag.y = w.y;
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    ch.mode = "knocked";
    ch.timer = 0.9;
    canvas.classList.remove("grabbing");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // =========================================================
  // Boot
  // =========================================================
  const pills = document.getElementById("ground-pills");
  pills.innerHTML = GROUNDS.map((g, i) =>
    `<button class="pill" data-i="${i}"><kbd>${(i + 1) % 10}</kbd>${g.name}</button>`
  ).join("");
  pills.querySelectorAll(".pill").forEach((p) => {
    p.addEventListener("pointerdown", (e) => e.preventDefault());
    p.addEventListener("click", () => setGround(Number(p.dataset.i)));
  });

  new ResizeObserver(() => { resize(); if (ch) snapCamera(); }).observe(canvas);
  resize();
  setGround(0);

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 14) { step(); acc -= DT; n++; }
    if (n === 14) acc = 0;
    updateCamera(dt);
    render();
    updateHUD();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
