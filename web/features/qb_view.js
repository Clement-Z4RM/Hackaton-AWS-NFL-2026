// Extension « Vue 3D du lanceur » : l'action vue à travers les yeux du lanceur (perspective simple).
// Caméra posée sur le lanceur, yeux à 1,9 m ; les angles du suivi (o) sont horaires depuis +y : dx = sin, dy = cos.
// Le cœur fournit deux conteneurs positionnés : #view3d (grande vue, onglet « Vue 3D ») et #view3dMini
// (vignette, onglet « Les deux »). Ils peuvent apparaître après le chargement : on s'y attache au rendu.
(() => {
  const EYE = 2.08;            // hauteur des yeux : 1,9 m ≈ 2,08 yd
  const BODY_H = 2.0, BODY_W = 0.75;
  const NEAR = 0.8, FAR = 80;
  const SIGHT = 1.0;           // un joueur à moins de 1 yd de la ligne de vue « cache » le receveur
  const RAD = Math.PI / 180;
  const CLOSE = 4.5;           // les joueurs à moins de 4,5 yd (la poche) deviennent transparents
  const BALL_Z = 2.2;          // hauteur du ballon quand le payload ne la donne pas
  const OUTCOME_COLORS = { C: "#22c55e", I: "#94a3b8", IN: "#ef4444" };
  const opts = { mode: "ahead", wide: true };

  const style = document.createElement("style");
  style.textContent = `
    .qbv-wrap { position: absolute; inset: 0; overflow: hidden; border-radius: 10px; }
    .qbv-canvas { display: block; position: absolute; inset: 0; }
    .qbv-modes { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; z-index: 2; }
    .qbv-modes button { font-size: 12px; padding: 4px 9px; background: rgba(15,23,42,.8); }
    .qbv-modes button.on { background: var(--open); color: #111; border-color: var(--open); }
    .qbv-caption { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; padding: 6px 12px;
                   background: linear-gradient(transparent, rgba(2,6,23,.85) 40%); color: var(--text); font-size: 14px; }
    .qbv-caption:empty { display: none; }
    .qbv-caption b { color: var(--open); }
    .qbv-mini .qbv-caption { font-size: 10px; padding: 3px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
  document.head.append(style);

  function makeView(sel, big) {
    const el = document.createElement("div");
    el.className = `qbv-wrap ${big ? "qbv-big" : "qbv-mini"}`;
    el.innerHTML = `${big ? `<div class="qbv-modes">
        <button data-mode="ahead" title="Regarder droit vers le terrain adverse">Devant</button>
        <button data-mode="shoulders" title="Regarder là où les épaules du lanceur sont tournées">Épaules</button>
        <button data-wide title="Champ de vision large (120°) ou normal (90°)">Large</button>
      </div>` : ""}
      <canvas class="qbv-canvas"></canvas>
      <div class="qbv-caption"></div>`;
    return { sel, big, el, canvas: el.querySelector("canvas"), caption: el.querySelector(".qbv-caption"), host: null };
  }
  const views = [makeView("#view3d", true), makeView("#view3dMini", false)];

  function syncButtons() {
    document.querySelectorAll(".qbv-modes [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === opts.mode));
    document.querySelectorAll(".qbv-modes [data-wide]").forEach((b) => b.classList.toggle("on", opts.wide));
  }
  views[0].el.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { opts.mode = b.dataset.mode; syncButtons(); GT.render(); }));
  views[0].el.querySelector("[data-wide]").onclick = () => { opts.wide = !opts.wide; syncButtons(); GT.render(); };
  syncButtons();

  // attache la vue à son conteneur s'il existe (il peut apparaître après coup ou être recréé)
  const ro = new ResizeObserver(() => GT.render());
  function attach(v) {
    const host = document.querySelector(v.sel);
    if (!host) return null;
    if (v.host !== host || v.el.parentElement !== host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.append(v.el);
      if (v.host) ro.unobserve(v.host);
      ro.observe(host);
      v.host = host;
    }
    return host;
  }
  const visible = (host) => host && !host.hidden && host.getClientRects().length > 0 && host.clientWidth > 0 && host.clientHeight > 0;

  // ---------------------------------------------------------------- géométrie
  function smoothedO(play, t) {
    // moyenne circulaire de l'orientation sur 3 images : l'orientation brute tremble
    const i = Math.floor(t);
    let sx = 0, sy = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(play.frames.length - 1, i); k++) {
      const q = play.frames[k].pos[play.passerId];
      if (q) { sx += Math.sin(q[3] * RAD); sy += Math.cos(q[3] * RAD); }
    }
    return sx || sy ? Math.atan2(sx, sy) / RAD : null;
  }

  function camera(now, play) {
    const q = play.passerId != null && now.pos[play.passerId];
    if (!q) return null;
    const heading = opts.mode === "shoulders" ? smoothedO(play, GT.state.t) ?? q[3] : 90;
    const th = heading * RAD;
    // regard f ; droite r (repère terrain : y vers le haut, donc à droite de +x il y a -y)
    return { x: q[0], y: q[1], heading, f: [Math.sin(th), Math.cos(th)], r: [Math.cos(th), -Math.sin(th)] };
  }

  const toCam = (cam, x, y) => {
    const dx = x - cam.x, dy = y - cam.y;
    return { u: dx * cam.r[0] + dy * cam.r[1], z: dx * cam.f[0] + dy * cam.f[1] };
  };

  function clipNear(pts, closed) {
    const out = [];
    const n = closed ? pts.length : pts.length - 1;
    if (!closed && pts[0].z >= NEAR) out.push(pts[0]);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ain = a.z >= NEAR, bin = b.z >= NEAR;
      if (closed && ain) out.push(a);
      if (ain !== bin) {
        const t = (NEAR - a.z) / (b.z - a.z);
        out.push({ u: a.u + (b.u - a.u) * t, z: NEAR });
      }
      if (!closed && bin) out.push(b);
    }
    return out;
  }

  // hauteur du ballon à l'instant t (interpolée), si le payload la fournit
  function ballHeight(play, t) {
    const i = Math.min(Math.floor(t), play.frames.length - 1);
    const j = Math.min(i + 1, play.frames.length - 1);
    const a = play.frames[i].ballZ, b = play.frames[j].ballZ;
    if (a == null) return null;
    return b == null ? a : a + (b - a) * (t - i);
  }

  // trajectoire du ballon en 3D : [x, y, z] du lancer jusqu'à la réception
  function ballPath(play) {
    const start = play.passIdx, end = play.arrivalIdx ?? play.frames.length - 1;
    const pts = [];
    for (let i = start; i <= end && i < play.frames.length; i++) {
      const f = play.frames[i];
      if (f.ball && f.ballZ != null) pts.push([f.ball[0], f.ball[1], f.ballZ]);
    }
    if (pts.length >= 2) return pts;
    // pas de hauteur fournie : arc parabolique vers le point de réception
    const s = play.frames[start]?.ball || play.frames[start]?.pos[play.passerId];
    if (!s || !play.catchPoint) return null;
    const [ex, ey] = play.catchPoint;
    const apex = Math.min(12, Math.hypot(ex - s[0], ey - s[1]) * 0.15);
    for (let k = 0; k <= 24; k++) {
      const u = k / 24;
      pts.push([s[0] + (ex - s[0]) * u, s[1] + (ey - s[1]) * u, 2 + (1.5 - 2) * u + 4 * apex * u * (1 - u)]);
    }
    return pts;
  }

  // ---------------------------------------------------------------- dessin
  function draw(v, now, play) {
    const cv = v.canvas;
    const W = v.host.clientWidth, H = v.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cam = camera(now, play);
    // horizon plus bas dans la grande vue : laisse la place à l'arc du ballon
    const hy = H * (v.big ? 0.42 : 0.36);
    const fov = opts.wide ? 120 : 90;
    const F = W / 2 / Math.tan((fov / 2) * RAD);
    const P = (c, h = 0) => [W / 2 + (F * c.u) / c.z, hy + (F * (EYE - h)) / c.z];

    // ciel et sol
    const sky = ctx.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, "#0b1120");
    sky.addColorStop(1, "#24324a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hy);
    ctx.fillStyle = "#123018";
    ctx.fillRect(0, hy, W, H - hy);
    if (!cam) {
      ctx.fillStyle = "#e2e8f0"; ctx.font = "13px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Lanceur introuvable sur cette action", W / 2, H / 2);
      v.caption.textContent = "";
      return;
    }

    const poly = (corners, fill) => {
      const pts = clipNear(corners.map(([x, y]) => toCam(cam, x, y)), true);
      if (pts.length < 3) return;
      ctx.beginPath();
      pts.forEach((c, i) => { const [sx, sy] = P(c); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const seg = (x1, y1, x2, y2, color, width) => {
      const pts = clipNear([toCam(cam, x1, y1), toCam(cam, x2, y2)], false);
      if (pts.length < 2) return;
      const [ax, ay] = P(pts[0]), [bx, by] = P(pts[1]);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    };

    // bandes de 5 yd (zones d'en-but plus sombres), lignes, bords du terrain
    for (let x = 0; x < 120; x += 5) {
      const fill = x < 10 || x >= 110 ? "#14532d" : (x / 5) % 2 ? "#2f7d32" : "#2b7330";
      poly([[x, 0], [x + 5, 0], [x + 5, 53.3], [x, 53.3]], fill);
    }
    for (let x = 10; x <= 110; x += 5) seg(x, 0, x, 53.3, `rgba(255,255,255,${x % 10 ? 0.25 : 0.55})`, 1);
    seg(0, 0, 120, 0, "rgba(255,255,255,0.8)", 1.5);
    seg(0, 53.3, 120, 53.3, "rgba(255,255,255,0.8)", 1.5);
    seg(play.los, 0, play.los, 53.3, "#60a5fa", 2);
    seg(play.firstDown, 0, play.firstDown, 53.3, "#fde047", 2.5);
    // voile de brume vers l'horizon
    const haze = ctx.createLinearGradient(0, hy, 0, hy + H * 0.12);
    haze.addColorStop(0, "rgba(36,50,74,0.85)");
    haze.addColorStop(1, "rgba(36,50,74,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, hy, W, H * 0.12);

    const atThrow = GT.state.t >= play.passIdx;

    // cible au sol (point de réception), anneaux projetés en perspective
    if (atThrow && play.catchPoint) {
      const [cx, cy] = play.catchPoint;
      for (const [r, a] of [[2, 0.5], [1, 0.9]]) {
        const ring = [];
        for (let k = 0; k < 32; k++) ring.push(toCam(cam, cx + r * Math.cos((k / 32) * 2 * Math.PI), cy + r * Math.sin((k / 32) * 2 * Math.PI)));
        const pts = clipNear(ring, true);
        if (pts.length < 3) continue;
        ctx.beginPath();
        pts.forEach((c, i) => { const [sx, sy] = P(c); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        ctx.closePath();
        ctx.strokeStyle = `rgba(251,146,60,${a})`;
        ctx.lineWidth = v.big ? 2.5 : 1.5;
        ctx.stroke();
      }
    }

    // trajectoire du ballon (arc en pointillés) une fois le lancer passé
    if (atThrow) {
      const path = ballPath(play);
      if (path) {
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = v.big ? 2 : 1.2;
        ctx.beginPath();
        let pen = false;
        for (const [x, y, z] of path) {
          const c = toCam(cam, x, y);
          if (c.z < NEAR) { pen = false; continue; }
          const [sx, sy] = P(c, z);
          pen ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
          pen = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // joueurs, du plus loin au plus proche
    const focusId = atThrow && play.info.openId ? play.info.openId : now.mostOpen;
    const items = [];
    for (const p of play.players) {
      if (p.id === play.passerId) continue;
      const q = now.pos[p.id];
      if (!q) continue;
      const c = toCam(cam, q[0], q[1]);
      if (c.z > 1.2 && c.z < FAR) items.push({ p, c });
    }
    items.sort((a, b) => b.c.z - a.c.z);

    for (const { p, c } of items) {
      const [sx, foot] = P(c, 0);
      const [, top] = P(c, BODY_H);
      const w = (F * BODY_W) / c.z;
      if (sx < -w * 2 || sx > W + w * 2) continue;
      const headR = w * 0.32;
      const isOpen = p.id === focusId;
      const isTarget = atThrow && p.id === play.info.targetId;
      const color = p.side === "offense" ? GT.COLORS.off : GT.COLORS.def;
      // on regarde « à travers » la poche : les joueurs tout proches sont estompés
      ctx.globalAlpha = isOpen || isTarget ? 1 : Math.max(0.15, Math.min(1, (c.z - 1.2) / (CLOSE - 1.2)));

      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.beginPath(); ctx.ellipse(sx, foot, w * 0.75, w * 0.22, 0, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, sx - w / 2, top + headR * 2, w, foot - top - headR * 2, Math.min(w * 0.3, 6));
      ctx.fill();
      ctx.beginPath(); ctx.arc(sx, top + headR, headR, 0, 2 * Math.PI); ctx.fill();
      if (isOpen || isTarget) {
        ctx.strokeStyle = isTarget ? GT.COLORS.target : GT.COLORS.open;
        ctx.lineWidth = v.big ? 3 : 2;
        roundRect(ctx, sx - w / 2 - 3, top - 3, w + 6, foot - top + 6, 5);
        ctx.stroke();
      }
      if (w > 9 && c.z > CLOSE * 0.7) {
        ctx.fillStyle = "white";
        ctx.font = `bold ${Math.min(w * 0.5, 22)}px system-ui`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(p.jersey, sx, top + headR * 2 + (foot - top - headR * 2) * 0.4);
        ctx.textBaseline = "alphabetic";
      }
      ctx.globalAlpha = 1;
      if ((isOpen || isTarget) && sx > -20 && sx < W + 20) {
        label(ctx, GT.lastName(p.name), sx, top - 6, isTarget ? GT.COLORS.target : GT.COLORS.open, W, v.big);
      }
    }

    // ballon en vol, avec son ombre au sol
    if (atThrow && now.ball) {
      const c = toCam(cam, now.ball[0], now.ball[1]);
      if (c.z > NEAR) {
        const z = ballHeight(play, GT.state.t) ?? BALL_Z;
        const r = Math.max(2, (F * 0.35) / c.z);
        const [gx, gy] = P(c, 0);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath(); ctx.ellipse(gx, gy, r * 1.3, r * 0.45, 0, 0, 2 * Math.PI); ctx.fill();
        const [bx, by] = P(c, z);
        ctx.fillStyle = GT.COLORS.ball;
        ctx.beginPath(); ctx.ellipse(bx, by, r * 1.4, r, 0, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = "white"; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // receveur le plus libre hors du champ : flèche sur le bord
    const focus = focusId != null && now.pos[focusId] && play.byId[focusId];
    let fc = null;
    if (focus) {
      fc = toCam(cam, now.pos[focusId][0], now.pos[focusId][1]);
      const sx = fc.z > NEAR ? W / 2 + (F * fc.u) / fc.z : fc.u > 0 ? W + 1 : -1;
      if (sx < 0 || sx > W) {
        const right = sx > W;
        const ax = right ? W - 8 : 8, ay = H * 0.55;
        ctx.fillStyle = GT.COLORS.open;
        ctx.beginPath();
        ctx.moveTo(ax + (right ? 6 : -6), ay);
        ctx.lineTo(ax + (right ? -6 : 6), ay - 8);
        ctx.lineTo(ax + (right ? -6 : 6), ay + 8);
        ctx.closePath(); ctx.fill();
        label(ctx, GT.lastName(focus.name), right ? W - 40 : 40, ay - 14, GT.COLORS.open, W, v.big);
      }
    }

    // repère du regard au centre
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 6, hy); ctx.lineTo(W / 2 + 6, hy); ctx.moveTo(W / 2, hy - 6); ctx.lineTo(W / 2, hy + 6); ctx.stroke();

    // suite simulée (après la fin des données réelles)
    const frame = play.frames[Math.min(Math.floor(GT.state.t), play.frames.length - 1)];
    if (frame?.sim) {
      ctx.font = `${v.big ? 12 : 9}px system-ui`;
      ctx.textAlign = "left";
      const txt = "Suite simulée";
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = "rgba(15,23,42,0.7)";
      ctx.fillRect(8, 8, tw + 10, v.big ? 18 : 14);
      ctx.fillStyle = "#cbd5e1";
      ctx.fillText(txt, 13, v.big ? 21 : 18);
    }

    // issue de la passe, en grand, une fois le ballon arrivé
    if (play.arrivalIdx != null && GT.state.t >= play.arrivalIdx && play.outcome?.text) {
      const col = OUTCOME_COLORS[play.outcome.result] || "#e2e8f0";
      ctx.font = `bold ${v.big ? Math.max(22, Math.min(40, W / 22)) : 15}px system-ui`;
      ctx.textAlign = "center";
      const tw = ctx.measureText(play.outcome.text).width;
      const y = H * (v.big ? 0.17 : 0.2);
      const pad = v.big ? 14 : 6, hgt = v.big ? 46 : 22;
      ctx.fillStyle = "rgba(2,6,23,0.75)";
      roundRect(ctx, W / 2 - tw / 2 - pad, y - hgt * 0.72, tw + 2 * pad, hgt, 8);
      ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillText(play.outcome.text, W / 2, y);
    }

    v.caption.innerHTML = caption(cam, fc, focus, items, fov, atThrow);
  }

  function caption(cam, fc, focus, items, fov, atThrow) {
    const lead = opts.mode === "shoulders" ? "Là où ses épaules sont tournées" : "Ce que voit le lanceur";
    if (!focus || !fc) return `${lead}.`;
    const dist = Math.hypot(fc.u, fc.z);
    // joueurs entre le lanceur et le receveur, à moins de SIGHT yd de la ligne de vue
    const L2 = fc.u * fc.u + fc.z * fc.z;
    const blockers = items.filter(({ p, c }) => {
      if (p.id === focus.id) return false;
      const t = (c.u * fc.u + c.z * fc.z) / L2;
      return t > 0.05 && t < 0.97 && Math.abs(c.u * fc.z - c.z * fc.u) / Math.sqrt(L2) < SIGHT;
    }).map(({ p }) => `n° ${p.jersey}`);
    const angle = Math.round(Math.abs(Math.atan2(fc.u, fc.z) / RAD));
    const who = `<b>${GT.lastName(focus.name)}</b>${atThrow ? "" : " (le plus libre maintenant)"}`;
    let txt = `${lead} — ${who} est à ${GT.num(dist, 0)} yd, `;
    txt += blockers.length
      ? `caché derrière ${blockers.length} joueur${blockers.length > 1 ? "s" : ""} (${blockers.join(", ")})`
      : "rien ne le cache";
    if (angle > fov / 2) txt += `, mais hors du champ de vision (à ${angle}° ${opts.mode === "shoulders" ? "de ses épaules" : "de l'axe du terrain"})`;
    return `${txt}.`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function label(ctx, text, x, y, color, W, big) {
    ctx.font = `bold ${big ? 14 : 11}px system-ui`;
    const w = ctx.measureText(text).width;
    const left = Math.max(2, Math.min(x - w / 2, W - w - 4));
    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(left - 3, y - (big ? 13 : 10), w + 6, big ? 17 : 14);
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(text, left, y);
  }

  GT.on("render", (ctx, view, now, play) => {
    for (const v of views) {
      const host = attach(v);
      if (visible(host)) draw(v, now, play);
    }
  });

  // ?regard=epaules démarre en mode « suivre ses épaules »
  const params = new URLSearchParams(location.search);
  if (params.get("regard") === "epaules") { opts.mode = "shoulders"; syncButtons(); }

  // ?test3d=1 : conteneurs de test (en attendant la nouvelle mise en page)
  if (params.get("test3d") && !document.querySelector("#view3d")) {
    const big = document.createElement("div");
    big.id = "view3d";
    big.style.cssText = "position:fixed;top:10px;left:10px;width:900px;height:500px;z-index:100;background:#0b1120;border-radius:10px";
    const mini = document.createElement("div");
    mini.id = "view3dMini";
    mini.style.cssText = "position:fixed;bottom:10px;right:10px;width:320px;height:180px;z-index:100;background:#0b1120;border-radius:10px";
    document.body.append(big, mini);
  }
})();
