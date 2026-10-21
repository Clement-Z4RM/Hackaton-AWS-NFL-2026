// Extension « Le regard du lanceur » : cône de vision du lanceur (orientation des épaules ± 30°).
// Convention des angles (vérifiée sur les données) : horaire depuis +y, donc dx = sin θ, dy = cos θ.
(() => {
  const HALF = 30, LEN = 30, WINDOW = 10, CYAN = "#67e8f9";
  const rad = (d) => (d * Math.PI) / 180;
  const angleOff = (q, p) => {
    const bearing = (Math.atan2(p[0] - q[0], p[1] - q[1]) * 180) / Math.PI;
    return Math.abs(((bearing - q[3] + 540) % 360) - 180);
  };
  const inCone = (pos, d, id) => {
    const q = pos[d.passerId], p = pos[id];
    return !!(q && p && angleOff(q, p) <= HALF);
  };

  // ---------------------------------------------------------------- calque : le cône
  const layer = GT.addLayer({
    id: "gaze",
    label: "Le regard du lanceur (cône de vision)",
    z: "under",
    draw(ctx, v, now, d) {
      const q = d.passerId && now.pos[d.passerId];
      if (!q) return;
      const cx = v.X(q[0]), cy = v.Y(q[1]);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, LEN * v.k);
      grad.addColorStop(0, "rgba(255,255,255,0.35)");
      grad.addColorStop(1, "rgba(255,255,255,0.03)");
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let a = q[3] - HALF; a <= q[3] + HALF + 0.1; a += 3) {
        ctx.lineTo(v.X(q[0] + LEN * Math.sin(rad(a))), v.Y(q[1] + LEN * Math.cos(rad(a))));
      }
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    },
  });

  // ---------------------------------------------------------------- par-dessus : receveurs regardés + joueur oublié
  GT.on("render", (ctx, v, now, d) => {
    syncBadge(d);
    if (!layer.on || !d.passerId || !now.pos[d.passerId]) return;
    for (const p of d.routes) {
      const pp = now.pos[p.id];
      if (!pp || !inCone(now.pos, d, p.id)) continue;
      ctx.beginPath();
      ctx.arc(v.X(pp[0]), v.Y(pp[1]), 1.3 * v.k, 0, 2 * Math.PI);
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    const openId = d.info.openId;
    if (GT.state.hideHints || !openId || openId === d.info.targetId || now.t < d.snapIdx) return;
    const pp = now.pos[openId];
    if (!pp) return;
    const seen = inCone(now.pos, d, openId);
    GT.tag(ctx, seen ? "dans le regard du lanceur" : "hors du regard du lanceur",
           v.X(pp[0]), v.Y(pp[1]) + 2.4 * v.k, seen ? CYAN : "#fca5a5", true);
  });

  // ---------------------------------------------------------------- pastille : la dernière seconde avant le lancer
  let badgeText = null, badgeShown = false;
  function lookedFrames(d, id) {
    let n = 0;
    for (let i = Math.max(0, d.passIdx - WINDOW); i <= d.passIdx; i++) if (inCone(d.frames[i].pos, d, id)) n++;
    return n;
  }
  GT.on("select", (d) => {
    badgeText = null;
    badgeShown = false;
    const { openId, targetId, open } = d.info;
    if (!d.passerId || !openId || openId === targetId) return;
    const n = lookedFrames(d, openId);
    badgeText = n === 0
      ? `Le lanceur n'a jamais regardé <b>${open}</b> dans la dernière seconde avant le lancer`
      : `Le lanceur a regardé <b>${open}</b> pendant ${GT.num(n / 10)} s dans la dernière seconde`;
  });
  function syncBadge() {
    const want = !!badgeText && !GT.state.hideHints;
    if (want === badgeShown) return;
    GT.setBadge("gaze", want ? badgeText : null);
    badgeShown = want;
  }

  // ---------------------------------------------------------------- panneau : sur toutes les actions
  const panel = GT.addPanel("Le regard du lanceur");
  panel.innerHTML = `<span class="muted">Calcul sur toutes les actions…</span>`;
  GT.api("/api/gaze/stats").then((s) => {
    const pct = (x) => `${Math.round(x * 100)} %`;
    const top = s.qbs.slice(0, 5).map((q) =>
      `<div class="gaze-row"><span>${q.qb}</span><b>${pct(q.never)}</b></div>`).join("");
    panel.innerHTML = `
      <p class="gaze-big"><b>${pct(s.neverLooked)}</b> des joueurs oubliés n'ont jamais été dans le regard du lanceur
         pendant la dernière seconde avant le lancer.</p>
      <p class="muted">Regard = direction des épaules du lanceur, ± ${s.halfAngle}°. Contrôle : le joueur visé est
         dans ce cône au moment du lancer dans ${pct(s.targetAtThrow)} des passes.</p>
      <p class="muted" style="margin:8px 0 4px">Les lanceurs qui regardent le moins leurs joueurs oubliés :</p>
      ${top}`;
  }).catch(() => (panel.innerHTML = `<span class="muted">Statistiques indisponibles.</span>`));

  const style = document.createElement("style");
  style.textContent = `
    .gaze-big { margin: 0 0 6px; font-size: 13px; }
    .gaze-big b { color: ${CYAN}; font-size: 18px; }
    .gaze-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; border-bottom: 1px solid var(--border); }
    .gaze-row b { color: #fca5a5; }`;
  document.head.append(style);
})();
