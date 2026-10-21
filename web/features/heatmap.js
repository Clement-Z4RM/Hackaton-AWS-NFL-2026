// Extension « Où sont les joueurs oubliés ? » : carte de chaleur des positions au lancer
// (panneau avec mini-terrain + calque projeté sur le grand terrain, aligné sur la ligne de départ).
(() => {
  const MODES = { ghost: "Joueurs oubliés", target: "Passes lancées", ratio: "Oubliés comparés aux passes" };
  // [position 0..1, r, g, b, opacité]
  const RAMPS = {
    ghost: [[0, 250, 204, 21, 0], [0.35, 251, 146, 60, 0.45], [0.75, 250, 204, 21, 0.8], [1, 255, 255, 255, 0.95]],
    target: [[0, 59, 130, 246, 0], [0.4, 96, 165, 250, 0.5], [1, 219, 234, 254, 0.95]],
  };
  const SCALE_TEXT = {
    ghost: ["peu d'oubliés", "beaucoup d'oubliés"],
    target: ["peu de passes", "beaucoup de passes"],
    ratio: ["les passes vont plutôt ici", "on y oublie des joueurs"],
  };
  const cache = {}, images = {};
  let mode = MODES[new URLSearchParams(location.search).get("hm")] ? new URLSearchParams(location.search).get("hm") : "ghost";

  const style = document.createElement("style");
  style.textContent = `
    .hm-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
    .hm-row select { font-size: 12px; }
    .hm-team { font-size: 12px; color: var(--muted); }
    .hm-team b { color: var(--open); }
    .hm-canvas { display: block; width: 100%; border-radius: 6px; }
    .hm-scale { height: 8px; border-radius: 4px; margin: 6px 0 2px; }
    .hm-scale-txt { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
    .hm-text { margin: 6px 0 4px; font-size: 13px; }`;
  document.head.append(style);

  const get = (team, m) => (cache[`${team}|${m}`] ??= GT.api(`/api/heatmap/grid?team=${encodeURIComponent(team || "")}&mode=${m}`));

  function color(v, m, vmax) {
    if (v == null) return [0, 0, 0, 0];
    if (m === "ratio") {
      const u = Math.max(-1, Math.min(1, v / 2));
      return u > 0 ? [250, 204, 21, 0.85 * u] : [59, 130, 246, 0.85 * -u];
    }
    const t = vmax > 0 ? Math.min(1, v / vmax) : 0, ramp = RAMPS[m];
    let i = 1;
    while (i < ramp.length - 1 && ramp[i][0] < t) i++;
    const [p0, ...a] = ramp[i - 1], [p1, ...b] = ramp[i];
    const u = (t - p0) / (p1 - p0 || 1);
    return a.map((x, k) => x + (b[k] - x) * u);
  }

  // une case de la grille = un pixel ; le navigateur lisse l'image quand on l'agrandit
  function toImage(g) {
    const nD = g.grid.length, nW = g.grid[0].length;
    const off = document.createElement("canvas");
    off.width = nD; off.height = nW;
    const octx = off.getContext("2d"), img = octx.createImageData(nD, nW);
    for (let i = 0; i < nD; i++) {
      for (let j = 0; j < nW; j++) {
        const [r, gr, bl, a] = color(g.grid[i][j], g.mode, g.vmax);
        const o = ((nW - 1 - j) * nD + i) * 4;   // y élevé (gauche de l'attaque) en haut
        img.data.set([r, gr, bl, Math.round(a * 255)], o);
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  // ---------------------------------------------------------------- panneau
  const body = GT.addPanel("Où sont les joueurs oubliés ?");
  body.innerHTML = `
    <div class="hm-row">
      <span class="hm-team"></span>
      <select class="hm-mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${k === mode ? "selected" : ""}>${v}</option>`).join("")}</select>
    </div>
    <canvas class="hm-canvas"></canvas>
    <div class="hm-scale"></div>
    <div class="hm-scale-txt"><span></span><span></span></div>
    <p class="hm-text"></p>
    <div class="muted">Position au moment du lancer, vue de dessus : l'attaque va vers la droite,
      la ligne bleue est la ligne de départ. Gauche et droite sont vues depuis le lanceur.</div>`;
  const cv = body.querySelector(".hm-canvas");

  function drawMini(g) {
    const W = body.clientWidth || 276, d0 = g.depthEdges[0], d1 = g.depthEdges.at(-1);
    const k = W / (d1 - d0), H = Math.round(GT.FIELD_W * k), dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const X = (d) => (d - d0) * k;
    ctx.fillStyle = "#1f5f2a";
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(toImage(g), 0, 0, W, H);
    ctx.font = "10px system-ui"; ctx.textAlign = "center";
    for (let d = 10; d < d1; d += 10) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(d), 0); ctx.lineTo(X(d), H); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(`${d} yd`, X(d), H - 4);
    }
    ctx.strokeStyle = "#60a5fa"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(0), 0); ctx.lineTo(X(0), H); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.textAlign = "left";
    ctx.fillText("gauche", 3, 11);
    ctx.fillText("droite", 3, H - 4);
  }

  function drawScale(m) {
    const bar = body.querySelector(".hm-scale"), [lo, hi] = SCALE_TEXT[m];
    const css = (c) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 0.08)})`;
    bar.style.background = m === "ratio"
      ? `linear-gradient(to right, ${css([59, 130, 246, 0.85])}, rgba(255,255,255,0.08), ${css([250, 204, 21, 0.85])})`
      : `linear-gradient(to right, ${RAMPS[m].map((s) => `${css(s.slice(1))} ${s[0] * 100}%`).join(", ")})`;
    const [a, b] = body.querySelectorAll(".hm-scale-txt span");
    a.textContent = lo; b.textContent = hi;
  }

  async function updatePanel() {
    const team = document.querySelector("#team").value;
    const g = await get(team, mode);
    body.querySelector(".hm-team").innerHTML = `Équipe (filtre de la liste) : <b>${team || "toutes"}</b>`;
    drawMini(g);
    drawScale(mode);
    body.querySelector(".hm-text").textContent =
      `${g.sentence} (${g.nGhost.toLocaleString("fr")} joueurs oubliés, ${g.nTarget.toLocaleString("fr")} passes)`;
  }

  body.querySelector(".hm-mode").onchange = (e) => { mode = e.target.value; updatePanel(); GT.render(); };
  document.querySelector("#team").addEventListener("change", updatePanel);
  window.addEventListener("resize", updatePanel);
  updatePanel();

  // ---------------------------------------------------------------- calque sur le grand terrain
  GT.addLayer({
    id: "heatmap",
    label: "Zones où l'équipe oublie ses joueurs",
    z: "under",
    draw(ctx, v, now, play) {
      const team = play.info && play.info.team;
      if (!team) return;
      const key = `${team}|${mode}`;
      if (!images[key]) {
        images[key] = "loading";
        get(team, mode).then((g) => { images[key] = { img: toImage(g), g }; GT.render(); });
        return;
      }
      if (images[key] === "loading") return;
      const { img, g } = images[key], d0 = g.depthEdges[0], d1 = g.depthEdges.at(-1);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(img, v.X(play.los + d0), v.Y(GT.FIELD_W), (d1 - d0) * v.k, GT.FIELD_W * v.k);
      ctx.globalAlpha = 1;
      GT.tag(ctx, `${MODES[mode]} de ${team} (toute la saison)`, v.W - 10, v.H - 10, mode === "target" ? "#93c5fd" : GT.COLORS.open, false, "left");
    },
  });
})();
