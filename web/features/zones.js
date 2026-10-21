// Zones de contrôle : chaque point du terrain prend la couleur de l'équipe qui le contrôle.
// Mode « plus proche » = diagramme de Voronoi ; mode « arrive en premier » = chaque joueur est d'abord
// avancé sur sa lancée (vitesse + direction actuelles) pendant le temps de réaction, puis court à vitesse max.
(() => {
  const RES = 0.5;     // taille d'une case de la grille (yd)
  const REACT = 0.5;   // temps de réaction : le joueur continue sur sa lancée (s)
  const OFF = [59, 130, 246], DEF = [239, 68, 68], ALPHA = 90;
  const params = new URLSearchParams(location.search);
  const opts = { mode: params.get("zones") === "first" ? "first" : "nearest", beyond: false };

  const off = document.createElement("canvas");
  const octx = off.getContext("2d");
  let cache = null;

  const style = document.createElement("style");
  style.textContent = `
    .zn-help { margin: 0 0 6px; font-size: 12px; color: var(--muted); }
    .zn-opts { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
    .zn-stats { font-size: 13px; line-height: 1.5; }
    .zn-stats b { font-size: 15px; }
    .zn-stats .zn-open { color: var(--open); }
    .zn-key { display: flex; gap: 12px; font-size: 12px; color: var(--muted); margin-top: 6px; }
    .zn-key i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 5px; vertical-align: -2px; }`;
  document.head.append(style);

  function compute(view, now, play) {
    const key = `${play.key}|${GT.state.t.toFixed(3)}|${opts.mode}|${opts.beyond}|${view.x0}`;
    if (cache && cache.key === key) return cache;

    const cols = Math.ceil(55 / RES), rows = Math.ceil(GT.FIELD_W / RES);
    const ps = play.players.filter((p) => now.pos[p.id]);
    const n = ps.length, px = new Float32Array(n), py = new Float32Array(n);
    ps.forEach((p, k) => {
      const [x, y, s = 0, , dir = 0] = now.pos[p.id];
      const a = (dir * Math.PI) / 180;
      const lead = opts.mode === "first" ? s * REACT : 0;
      px[k] = x + lead * Math.sin(a);
      py[k] = y + lead * Math.cos(a);
    });

    if (off.width !== cols || off.height !== rows) { off.width = cols; off.height = rows; }
    const img = octx.createImageData(cols, rows);
    const owner = new Int16Array(cols * rows);
    const openIdx = ps.findIndex((p) => p.id === play.info.openId);
    let ahead = 0, aheadOff = 0, openCells = 0;

    for (let j = 0; j < rows; j++) {
      const cy = GT.FIELD_W - (j + 0.5) * RES;
      for (let i = 0; i < cols; i++) {
        const cx = view.x0 + (i + 0.5) * RES;
        let best = Infinity, who = 0;
        for (let k = 0; k < n; k++) {
          const dx = px[k] - cx, dy = py[k] - cy, d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; who = k; }
        }
        const c = j * cols + i;
        owner[c] = who;
        const isOff = ps[who].side === "offense";
        if (cx >= play.los) { ahead++; if (isOff) aheadOff++; }
        if (who === openIdx) openCells++;
        if (opts.beyond && cx < play.los) continue;
        const col = isOff ? OFF : DEF;
        img.data.set([col[0], col[1], col[2], ALPHA], c * 4);
      }
    }
    octx.putImageData(img, 0, 0);
    cache = { key, cols, rows, owner, openIdx, openName: openIdx >= 0 ? ps[openIdx].name : null,
              offShare: ahead ? aheadOff / ahead : 0, openArea: openCells * RES * RES };
    return cache;
  }

  function outlineOpenZone(ctx, view, c) {
    if (c.openIdx < 0) return;
    const s = RES * view.k, { cols, rows, owner, openIdx } = c;
    const mine = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && owner[j * cols + i] === openIdx;
    ctx.beginPath();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!mine(i, j)) continue;
        const x = i * s, y = j * s;
        if (!mine(i - 1, j)) { ctx.moveTo(x, y); ctx.lineTo(x, y + s); }
        if (!mine(i + 1, j)) { ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); }
        if (!mine(i, j - 1)) { ctx.moveTo(x, y); ctx.lineTo(x + s, y); }
        if (!mine(i, j + 1)) { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y + s); }
      }
    }
    ctx.strokeStyle = GT.COLORS.open;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ---------------------------------------------------------------- panneau
  const panel = GT.addPanel("Zones de contrôle");
  panel.innerHTML = `
    <p class="zn-help">Chaque point du terrain prend la couleur de l'équipe qui le contrôle.</p>
    <div class="zn-opts">
      <label class="check"><input type="radio" name="zn-mode" value="nearest"> Le joueur le plus proche</label>
      <label class="check"><input type="radio" name="zn-mode" value="first"> Qui arrive en premier (vitesse et direction)</label>
      <label class="check"><input type="checkbox" id="zn-beyond"> Seulement devant la ligne de départ</label>
    </div>
    <div class="zn-stats" id="zn-stats"></div>
    <div class="zn-key"><span><i style="background:rgb(${OFF})"></i>Attaque</span><span><i style="background:rgb(${DEF})"></i>Défense</span><span><i style="border:2px solid var(--open)"></i>Zone du plus libre</span></div>`;
  const statsEl = panel.querySelector("#zn-stats");
  const IDLE = "Cochez « Zones de contrôle » dans les calques pour colorier le terrain.";
  statsEl.textContent = IDLE;
  panel.querySelector(`input[value="${opts.mode}"]`).checked = true;

  // changer une option active aussi le calque (via sa case dans « Calques sur le terrain »)
  function enableLayer() {
    if (layer.on) return GT.render();
    const box = [...document.querySelectorAll("#layerToggles label")].find((l) => l.textContent.includes(layer.label));
    const input = box?.querySelector("input");
    if (input) { input.checked = true; input.dispatchEvent(new Event("change")); } else { layer.on = true; GT.render(); }
  }
  panel.querySelectorAll('input[name="zn-mode"]').forEach((r) => (r.onchange = () => { opts.mode = r.value; enableLayer(); }));
  panel.querySelector("#zn-beyond").onchange = (e) => { opts.beyond = e.target.checked; enableLayer(); };

  let lastStats = "", lastBadge = "";
  function updateStats(c) {
    const share = GT.pct(c.offShare);
    let html = `Devant la ligne, l'attaque contrôle <b>${share}</b> de l'espace visible.`;
    if (!GT.state.hideHints && c.openName && GT.state.t >= GT.state.play.snapIdx) {
      html += `<br><span class="zn-open"><b>${GT.lastName(c.openName)}</b> contrôle <b>${Math.round(c.openArea)} yd²</b> à lui seul.</span>`;
    }
    if (html !== lastStats) { statsEl.innerHTML = html; lastStats = html; }
    const badge = `Zones : l'attaque contrôle ${share} de l'espace devant la ligne`;
    if (badge !== lastBadge || !document.querySelector('#badges [data-id="zones"]')) { GT.setBadge("zones", badge); lastBadge = badge; }
  }

  // ---------------------------------------------------------------- calque
  const layer = GT.addLayer({
    id: "zones",
    label: "Zones de contrôle",
    z: "under",
    draw(ctx, view, now, play) {
      const c = compute(view, now, play);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, 0, c.cols * RES * view.k, c.rows * RES * view.k);
      if (!GT.state.hideHints && GT.state.t >= play.snapIdx) outlineOpenZone(ctx, view, c);
      updateStats(c);
    },
  });

  GT.on("render", () => {
    if (layer.on || !lastStats) return;
    statsEl.textContent = IDLE;
    GT.setBadge("zones", null);
    lastStats = lastBadge = "";
  });
})();
