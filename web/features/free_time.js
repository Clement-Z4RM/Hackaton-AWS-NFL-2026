// « Temps libre ignoré » : depuis combien de temps le joueur le plus libre était seul (≥ 5 yd) quand le ballon est parti.
(() => {
  const OPEN_YDS = 5;
  const RING_MAX_S = 3; // l'anneau autour du joueur est plein à 3 s seul

  const style = document.createElement("style");
  style.textContent = `
    .ft-intro { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
    .ft-sum { font-size: 12px; margin-bottom: 8px; }
    .ft-sum b { color: var(--open); }
    .ft-h { font-size: 12px; font-weight: 600; margin: 8px 0 4px; }
    .ft-row { cursor: pointer; padding: 3px 4px; border-radius: 6px; font-size: 12px; }
    .ft-row:hover { background: var(--panel-2); }
    .ft-row .ft-line { display: flex; justify-content: space-between; gap: 6px; }
    .ft-row .ft-line span:last-child { color: var(--open); font-variant-numeric: tabular-nums; white-space: nowrap; }`;
  document.head.append(style);

  // ---------------------------------------------------------------- chrono du plus libre, image par image
  let streaks = []; // secondes seul d'affilée du plus libre au lancer, pour chaque image
  function computeStreaks(d) {
    const id = d.info.openId;
    let s = 0;
    return d.frames.map((f, i) => {
      if (i < d.snapIdx || id == null) return 0;
      if (i <= d.passIdx) s = (f.sep[id] ?? 0) >= OPEN_YDS ? s + 0.1 : 0;
      return s;
    });
  }

  GT.on("select", async (d) => {
    streaks = computeStreaks(d);
    GT.setBadge("free_time", null);
    const r = await GT.api(`/api/free_time/play/${d.gameId}/${d.playId}`);
    if (GT.state.play !== d || !r || r.error) return;
    const n = (x) => `<b>${GT.num(x)} s</b>`;
    let html;
    if (r.openStreak <= 0) html = "Personne n'était seul (5 yd ou plus) au moment du lancer";
    else if (r.same) html = `Le joueur visé, ${r.target}, était seul depuis ${n(r.openStreak)} : bon choix`;
    else html = `<span class="open">${GT.lastName(r.open)}</span> était seul depuis ${n(r.openStreak)} quand le ballon est parti ; le visé (${GT.lastName(r.target)}), ${n(r.targetStreak)}`;
    GT.setBadge("free_time", html);
  });

  // le quiz masque les indices : on cache la pastille tant qu'il est actif
  GT.on("render", () => {
    const el = document.querySelector('#badges [data-id="free_time"]');
    if (el) el.style.display = GT.state.hideHints ? "none" : "";
  });

  GT.addLayer({
    id: "free_time",
    label: "Chrono « seul depuis… » du joueur le plus libre",
    z: "over",
    draw(ctx, v, now, d) {
      const id = d.info.openId;
      if (GT.state.hideHints || id == null || now.t < d.snapIdx) return;
      const s = streaks[Math.min(Math.floor(now.t), d.passIdx)] || 0;
      const q = now.pos[id];
      if (!q || s <= 0) return;
      const x = v.X(q[0]), y = v.Y(q[1]);
      const hot = s >= 1;
      // anneau qui se remplit avec le temps passé seul
      ctx.beginPath();
      ctx.arc(x, y, 1.5 * v.k, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(s / RING_MAX_S, 1));
      ctx.strokeStyle = hot ? GT.COLORS.open : "white";
      ctx.lineWidth = 4;
      ctx.stroke();
      GT.tag(ctx, `seul depuis ${GT.num(s)} s`, x, y + 2.9 * v.k, hot ? GT.COLORS.open : "white", hot);
    },
  });

  // ---------------------------------------------------------------- panneau classement
  const panel = GT.addPanel("Temps libre ignoré");
  panel.innerHTML = `<p class="ft-intro">Secondes pendant lesquelles le joueur oublié était seul (5 yd ou plus) juste avant le lancer, additionnées sur toutes ses actions. Cliquez sur un nom pour revoir son pire oubli.</p><div class="meta">Chargement…</div>`;

  function rows(list, label) {
    const max = Math.max(1, ...list.map((r) => r.seconds));
    const box = document.createElement("div");
    box.innerHTML = `<div class="ft-h">${label}</div>`;
    for (const r of list) {
      const el = document.createElement("div");
      el.className = "ft-row";
      el.title = `Pire oubli : seul depuis ${GT.num(r.worst.streak)} s`;
      el.innerHTML = `
        <div class="ft-line"><span>${r.name} <span class="meta">${r.pos ? r.pos + " · " : ""}${r.team} · ${r.plays} actions</span></span><span>${GT.num(r.seconds)} s</span></div>
        <div class="bar"><i style="width:${(100 * r.seconds) / max}%"></i></div>`;
      el.onclick = () => GT.selectPlay(r.worst.gameId, r.worst.playId);
      box.append(el);
    }
    return box;
  }

  GT.api("/api/free_time/ranking").then((r) => {
    const s = r.summary;
    panel.querySelector(".meta").remove();
    const sum = document.createElement("div");
    sum.className = "ft-sum";
    sum.innerHTML = `Quand un joueur est oublié, il est seul depuis <b>${GT.num(s.medianStreak)} s</b> en médiane (le visé : ${GT.num(s.targetMedian)} s). Dans <b>${GT.pct(s.over1s)}</b> des cas, depuis plus d'une seconde.`;
    panel.append(sum, rows(r.players, "Joueurs les plus oubliés"), rows(r.qbs, "Lanceurs qui laissent le plus de temps libre"));
  });
})();
