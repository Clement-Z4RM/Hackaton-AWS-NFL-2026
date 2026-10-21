// Outil d'analyse des passes : rejoue une action à partir de l'API Python (server.py).
// Les extensions (web/features/*.js, chargées automatiquement) passent uniquement par window.GT :
//   GT.addLayer({id, label, z: "under"|"over", draw(ctx, view, now, play)})  calque activable au-dessus du terrain
//   GT.addPanel(title) -> élément HTML                                        panneau (page Tendances ou réglages)
//   GT.on("select" | "advance" | "click" | "render", fn)                      crochets (voir plus bas)
//   GT.setBadge(id, html)                                                     ligne dans « À retenir »
const $ = (s) => document.querySelector(s);
const COLORS = { open: "#facc15", target: "#fb923c", off: "#3b82f6", def: "#ef4444", ball: "#a16207" };
const VERDICT = {
  possible: { label: "Possible", color: "#22c55e" },
  serree: { label: "Serrée", color: "#f59e0b" },
  contestee: { label: "Contestée", color: "#ef4444" },
};
const OUTCOME_COLORS = { C: "#22c55e", I: "#cbd5e1", IN: "#ef4444" };
const CHIP_LABELS = { passes: "Passes", free_time: "Temps seul", gaze: "Regard", zones: "Contrôle", heatmap: "Oublis" };
const FIELD_W = 53.3, VIEW_W = 55;

// hideHints : masque le plus libre / le visé / la chronologie
const state = {
  play: null, t: 0, playing: false, speed: 0.5, last: 0, holdUntil: 0, view: "top",
  game: "", team: "", player: null, hideHints: false, options: null, selOpt: null,
};
const params = new URLSearchParams(location.search);
const startLayers = (params.get("on") || "").split(",");

const api = (path) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
const pct = (x) => `${Math.round(x * 100)} %`;
const num = (x, d = 1) => (x ?? 0).toFixed(d).replace(".", ",");
const signed = (x) => `${x >= 0 ? "+" : "−"}${num(Math.abs(x))} s`;
const lastName = (n) => n.split(" ").slice(1).join(" ") || n;

// ------------------------------------------------------------------ API des extensions
const hooks = { select: [], advance: [], click: [], render: [] };
const layers = [];
const GT = {
  state, COLORS, api, num, pct, lastName, FIELD_W,
  view: null,                       // {X, Y, k, x0, W, H} : yards -> pixels du terrain, mis à jour à chaque image
  // select(play)                   : une action vient d'être chargée
  // advance(prevT, nextT, ts) -> t : peut modifier/bloquer l'avancée du temps
  // click({x, y, player})          : clic sur le terrain (coordonnées en yards, joueur le plus proche à < 2 yd)
  // render(ctx, view, now, play)   : appelé après chaque image dessinée
  on(evt, fn) { hooks[evt].push(fn); },
  addLayer(layer) {
    const l = { z: "over", ...layer, on: layer.on || startLayers.includes(layer.id) };
    layers.push(l);
    renderLayerChips();
    return l;
  },
  addPanel(title) {
    // les réglages des zones vont sous le rapport ; les classements et cartes vont dans Tendances
    const settings = /zones de contrôle/i.test(title);
    const p = document.createElement("div");
    p.className = "panel";
    p.innerHTML = `<h3>${title}</h3>`;
    const body = document.createElement("div");
    p.append(body);
    (settings ? $("#layerSettings") : $("#trendsGrid")).append(p);
    return body;
  },
  setBadge(id, html) {
    let el = document.querySelector(`#badges [data-id="${id}"]`);
    if (!html) return el?.remove();
    if (!el) { el = document.createElement("div"); el.className = "badge"; el.dataset.id = id; $("#badges").append(el); }
    el.innerHTML = html;
  },
  interp: (t) => interp(t),
  play: () => play(), pause: () => pause(),
  seek(t) { state.t = t; pause(); },
  selectPlay: (g, p, atThrow) => selectPlay(g, p, atThrow),
  render: () => state.play && render(),
};
window.GT = GT;

function fire(evt, ...args) {
  for (const fn of hooks[evt]) {
    try { fn(...args); } catch (err) { console.error(`extension (${evt})`, err); }
  }
}

function renderLayerChips() {
  const box = $("#layerChips");
  box.innerHTML = "";
  for (const l of layers) {
    const b = document.createElement("button");
    b.textContent = CHIP_LABELS[l.id] || l.label;
    b.title = l.label;
    b.classList.toggle("on", l.on);
    b.onclick = () => { l.on = !l.on; b.classList.toggle("on", l.on); syncLayerSettings(); GT.render(); };
    box.append(b);
  }
  syncLayerSettings();
}

function syncLayerSettings() {
  const zones = layers.find((l) => l.id === "zones");
  $("#layerSettings").hidden = !(zones && zones.on && $("#layerSettings").children.length);
}

async function loadFeatures() {
  const files = await api("/api/features");
  for (const f of files) {
    await new Promise((ok) => {
      const s = document.createElement("script");
      s.src = `features/${f}`;
      s.onload = s.onerror = ok;
      document.body.append(s);
    });
  }
}

// ------------------------------------------------------------------ navigation entre les vues
function showView(name) {
  for (const v of ["home", "analysis", "trends"]) $(`#${v}`).hidden = v !== name;
  document.querySelectorAll(".nav-tabs a").forEach((a) => a.classList.toggle("on", a.dataset.view === name));
  if (name === "analysis") requestAnimationFrame(resize);
}

function route() {
  const h = location.hash.slice(1);
  if (h === "" || h === "accueil") return showView("home");
  if (h === "tendances") return showView("trends");
  showView("analysis");
  const [g, p, at] = h.split("-");
  if (/^\d+$/.test(g) && /^\d+$/.test(p ?? "")) {
    if (!state.play || state.play.key !== `${g}-${p}`) selectPlay(+g, +p, at);
  } else if (!state.play) {
    const first = document.querySelector("#plays .card");
    first?.click();
  }
}

// ------------------------------------------------------------------ chargement
async function init() {
  const s = await api("/api/summary");
  $("#keyFacts").innerHTML = `
    <div class="fact"><b>${s.passes.toLocaleString("fr")}</b><span>passes analysées</span></div>
    <div class="fact"><b>${pct(s.notMostOpen)}</b><span>ne visent pas le receveur le plus libre</span></div>
    <div class="fact"><b>${pct(s.ghostRate)}</b><span>ignorent un receveur seul (5 yards ou plus)</span></div>
    <div class="fact"><b>${pct(s.compOpen)} / ${pct(s.compOther)}</b><span>de passes réussies : vers le plus libre / vers un autre</span></div>`;
  for (const t of s.teams) $("#team").add(new Option(t, t));

  $("#game").onchange = (e) => { state.game = e.target.value; loadPlays(true); };
  $("#team").onchange = (e) => { state.team = e.target.value; loadPlays(true); };
  $("#ghostOnly").onchange = () => loadPlays(true);
  $("#playerFilter").onclick = () => { state.player = null; loadPlays(true); };
  document.querySelectorAll(".pos-filter input").forEach((i) => (i.onchange = loadRanking));
  document.querySelectorAll("#viewSeg button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));

  $("#playBtn").onclick = togglePlay;
  $("#restartBtn").onclick = () => { state.t = 0; state.holdUntil = 0; play(); };
  $("#throwBtn").onclick = () => { if (state.play) GT.seek(state.play.passIdx); };
  $("#scrub").oninput = (e) => GT.seek(+e.target.value);
  $("#speed").onchange = (e) => (state.speed = +e.target.value);
  $("#field").onclick = onFieldClick;
  $("#gifBtn").onclick = downloadGif;
  for (const id of ["ballSpeed", "defSpeed"]) {
    $(`#${id}`).oninput = () => {
      $("#ballVal").textContent = $("#ballSpeed").value;
      $("#defVal").textContent = $("#defSpeed").value;
      clearTimeout(state.optTimer);
      state.optTimer = setTimeout(loadOptions, 200);
    };
  }
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !$("#analysis").hidden && !["SELECT", "INPUT"].includes(e.target.tagName)) {
      e.preventDefault(); togglePlay();
    }
  });
  new ResizeObserver(resize).observe($("#fieldWrap"));
  window.addEventListener("resize", resize);
  window.addEventListener("hashchange", route);
  setupUpload();

  GT.addLayer({ id: "passes", label: "Trajectoires vers chaque receveur, colorées selon que la passe était possible ou non", on: true, draw: drawPasses });
  await loadFeatures();
  await Promise.all([loadGames(), loadPlays(), loadRanking(), loadValidation()]);
  if (["top", "3d", "both"].includes(params.get("vue"))) setView(params.get("vue"));
  route();
  requestAnimationFrame(tick);
}

async function loadGames() {
  const games = await api("/api/games");
  const sel = $("#game"), keep = sel.value;
  sel.length = 1;
  for (const g of games) sel.add(new Option(`Semaine ${g.week} · ${g.visitor} chez ${g.home} (${g.ghosts} oublis)`, g.gameId));
  sel.value = keep;
  const n = games.reduce((a, g) => a + g.passes, 0);
  $("#datasetInfo").textContent = `${games.length} matchs · ${n.toLocaleString("fr")} passes`;
}

async function loadPlays(selectFirst = false) {
  const q = new URLSearchParams({ ghost: $("#ghostOnly").checked ? 1 : 0 });
  if (state.game) q.set("game", state.game);
  if (state.team) q.set("team", state.team);
  if (state.player) q.set("player", state.player.id);
  $("#playerFilter").hidden = !state.player;
  if (state.player) $("#playerFilter").textContent = `Oublis de ${state.player.name} ✕`;

  const plays = await api(`/api/plays?${q}`);
  $("#listHead").textContent = `${plays.length} action${plays.length > 1 ? "s" : ""}`;
  $("#plays").innerHTML = plays.length ? "" : "<p class='meta'>Aucune action pour ces filtres.</p>";
  for (const p of plays) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.key = `${p.gameId}-${p.playId}`;
    el.innerHTML = `
      <div class="meta">${p.team} contre ${p.opp} · ${p.quarter}e quart · tentative ${p.down}, ${p.togo} yd</div>
      <div class="open">${p.open} : ${num(p.sepOpen)} yd d'espace</div>
      <div class="tgt">Visé : ${p.target} (${num(p.sepTarget)} yd) · ${p.result}</div>`;
    el.onclick = () => selectPlay(p.gameId, p.playId);
    $("#plays").append(el);
  }
  if (selectFirst && plays.length) selectPlay(plays[0].gameId, plays[0].playId);
  markActive();
}

async function loadRanking() {
  const pos = [...document.querySelectorAll(".pos-filter input:checked")].map((i) => i.value).join(",");
  const rk = pos ? await api(`/api/ranking?pos=${pos}`) : [];
  const max = Math.max(1, ...rk.map((r) => r.ghosts));
  $("#rankingList").innerHTML = "";
  rk.slice(0, 12).forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "rank";
    el.innerHTML = `
      <div><b>${i + 1}. ${r.name}</b> <span class="meta">${r.pos} · ${r.team}</span></div>
      <div class="meta">Oublié ${r.ghosts} fois sur ${r.routes} courses (${num(r.rate * 100)} %)</div>
      <div class="bar"><i style="width:${(100 * r.ghosts) / max}%"></i></div>`;
    el.onclick = () => {
      state.player = { id: r.nflId, name: r.name };
      state.game = state.team = ""; $("#game").value = ""; $("#team").value = ""; $("#ghostOnly").checked = true;
      location.hash = "#analyse";
      loadPlays(true);
    };
    $("#rankingList").append(el);
  });
}

async function loadValidation() {
  try {
    const v = await api("/api/passing/validation");
    $("#validation").classList.remove("muted");
    $("#validation").innerHTML = `
      <p class="muted">Pour chaque passe réellement tentée, on calcule le verdict au moment du lancer, puis on regarde si elle a été réussie.</p>
      <div class="vbars">${v.byVerdict.map((b) => `
        <div class="vbar"><span>${VERDICT[b.verdict]?.label ?? b.label}</span>
          <div class="track"><i style="width:${b.completion * 100}%;background:${VERDICT[b.verdict]?.color ?? "#64748b"}"></i></div>
          <b>${pct(b.completion)}</b></div>`).join("")}
      </div>
      <p>${v.text}</p>`;
  } catch {
    $("#validation").textContent = "Calcul indisponible pour le moment.";
  }
}

// at : "lancer" (figé au lancer), "fin" (figé sur la dernière image) ou rien (lecture)
async function selectPlay(gameId, playId, at = null) {
  showView("analysis");
  const d = await api(`/api/play/${gameId}/${playId}`);
  d.key = `${gameId}-${playId}`;
  d.gameId = gameId;
  d.playId = playId;
  d.byId = Object.fromEntries(d.players.map((p) => [p.id, p]));
  d.snapIdx = Math.max(0, d.frames.findIndex((f) => f.frame === d.snapFrame));
  d.passIdx = d.passFrame ? d.frames.findIndex((f) => f.frame === d.passFrame) : d.frames.length - 1;
  d.realEndIdx ??= d.frames.length - 1;
  d.routes = d.players.filter((p) => p.route);
  state.play = d;
  state.t = 0;
  state.holdUntil = 0;
  state.options = null;
  state.selOpt = null;
  history.replaceState(null, "", `${location.search}#${d.key}`);
  $("#scrub").max = d.frames.length - 1;
  $("#badges").innerHTML = "";

  const i = d.info;
  $("#playMeta").textContent = i.team
    ? `${i.team} contre ${i.opp} · ${i.quarter}e quart-temps · tentative ${i.down}, ${i.togo} yd à faire` : "";
  $("#verdict").innerHTML = i.target
    ? `<b>${i.qb}</b> lance vers <span class="tgt">${i.target}</span> (${num(i.sepTarget)} yd d'espace).
       ${i.openId !== i.targetId ? `<span class="open">${i.open}</span> était le plus libre avec ${num(i.sepOpen)} yd.` : "C'était bien le receveur le plus libre."}
       <small title="${d.description}">${d.description}</small>`
    : `<small>${d.description}</small>`;
  const out = d.outcome;
  $("#outcome").className = `outcome ${out?.result ?? ""}`;
  $("#outcome").textContent = out ? `Résultat : ${out.text}` : "";
  buildTimelineLegend();
  markActive();
  if (at === "lancer" || at === true) { state.t = d.passIdx; pause(); }
  else if (at === "fin") { state.t = d.frames.length - 1; pause(); }
  else if (/^f\d+(\.\d+)?$/.test(at ?? "")) { state.t = Math.min(+at.slice(1), d.frames.length - 1); pause(); }
  else play();
  fire("select", d);
  render();
  loadOptions();
}

async function loadOptions() {
  const d = state.play;
  if (!d) return;
  const q = new URLSearchParams({ ball: $("#ballSpeed").value, def: $("#defSpeed").value });
  try {
    const o = await api(`/api/passing/options/${d.gameId}/${d.playId}?${q}`);
    if (state.play !== d) return;
    state.options = o;
  } catch {
    state.options = null;
  }
  renderOptions();
  GT.render();
}

function renderOptions() {
  const o = state.options, table = $("#optionsTable");
  if (!o?.options?.length) {
    $("#optionsSummary").textContent = o?.summary || "Pas de passe tentée sur cette action, ou calcul indisponible.";
    table.innerHTML = "";
    return;
  }
  $("#optionsSummary").textContent = o.summary;
  table.innerHTML = `<tr><th>Receveur</th><th>Espace</th><th title="Depuis combien de temps il avait au moins 5 yards d'espace au moment du lancer">Seul depuis</th><th title="Dans le cône de vision du lanceur au moment du lancer">Regardé</th><th>Passe</th></tr>`;
  for (const op of o.options) {
    const v = VERDICT[op.verdict] ?? { label: op.verdict };
    const tr = document.createElement("tr");
    tr.className = `row${state.selOpt === op.id ? " sel" : ""}`;
    tr.innerHTML = `
      <td><span class="name">${lastName(op.name)}</span> <span class="meta">${op.pos ?? ""}</span>
        ${op.isTarget ? '<span class="tag t">visé</span>' : ""}${op.isMostOpen ? '<span class="tag o">plus libre</span>' : ""}</td>
      <td>${num(op.sep)} yd</td>
      <td>${num(op.alone ?? 0)} s</td>
      <td>${op.inGaze ? "oui" : "—"}</td>
      <td><span class="pill ${op.verdict}">${v.label} ${signed(op.margin)}</span></td>`;
    tr.onclick = () => {
      state.selOpt = state.selOpt === op.id ? null : op.id;
      if (state.t < state.play.passIdx) GT.seek(state.play.passIdx);
      renderOptions();
      GT.render();
    };
    table.append(tr);
  }
}

function markActive() {
  document.querySelectorAll("#plays .card").forEach((c) => c.classList.toggle("active", state.play && c.dataset.key === state.play.key));
}

function setView(v) {
  state.view = v;
  document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $("#field").hidden = v === "3d";
  $("#view3d").hidden = v !== "3d";
  $("#view3dMini").hidden = v !== "both";
  resize();
}

async function downloadGif() {
  const d = state.play, btn = $("#gifBtn");
  if (!d) return;
  btn.textContent = "Préparation du GIF…";
  btn.disabled = true;
  try {
    const r = await fetch(`/api/export/${d.gameId}/${d.playId}.gif`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `action_${d.key}.gif`;
    a.click();
  } finally {
    btn.textContent = "⤓ GIF";
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ glisser-déposer des fichiers d'un match
function setupUpload() {
  const drop = $("#drop");
  for (const e of ["dragenter", "dragover"]) drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  for (const e of ["dragleave", "drop"]) drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); });
  drop.addEventListener("drop", (ev) => uploadFiles(ev.dataTransfer.files));
  $("#fileInput").onchange = (e) => uploadFiles(e.target.files);
  // un fichier lâché à côté de la zone ne doit pas ouvrir le CSV dans le navigateur
  for (const e of ["dragover", "drop"]) window.addEventListener(e, (ev) => ev.preventDefault());
}

async function uploadFiles(files) {
  if (!files.length) return;
  const status = $("#uploadStatus");
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  status.innerHTML = `Analyse de ${files.length} fichier${files.length > 1 ? "s" : ""}… (jusqu'à une minute si les données doivent être recalculées)`;
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const res = await r.json();
    const lines = (res.warnings || []).map((w) => `<div class="warn">${w}</div>`);
    if (res.error) lines.unshift(`<div class="warn">${res.error}</div>`);
    if (res.games?.length) {
      lines.unshift(`<div class="ok">${res.games.length} match${res.games.length > 1 ? "s" : ""} prêt${res.games.length > 1 ? "s" : ""} à analyser.</div>`);
      await loadGames();
      state.game = String(res.games[0]);
      state.team = ""; state.player = null;
      $("#game").value = state.game; $("#team").value = ""; $("#ghostOnly").checked = false;
      await loadPlays();
      lines.push(`<a class="btn primary" href="#analyse" id="goMatch">Analyser ce match</a>`);
    }
    status.innerHTML = lines.join("");
    $("#goMatch")?.addEventListener("click", () => setTimeout(() => document.querySelector("#plays .card")?.click(), 0));
  } catch {
    status.innerHTML = `<div class="warn">L'envoi a échoué.</div>`;
  }
}

// ------------------------------------------------------------------ lecture
function play() {
  state.playing = true;
  state.last = performance.now();
  if (state.play && state.t >= state.play.frames.length - 1) state.t = 0;
  $("#playBtn").textContent = "⏸";
}
function pause() { state.playing = false; $("#playBtn").textContent = "▶"; }
function togglePlay() { state.playing ? pause() : play(); }

function tick(ts) {
  const d = state.play;
  if (d && state.playing && ts >= state.holdUntil) {
    const dt = Math.min(0.1, Math.max(0, (ts - state.last) / 1000));
    let t = state.t + dt * 10 * state.speed;
    if ($("#pauseThrow").checked && state.t < d.passIdx && t >= d.passIdx) {
      t = d.passIdx;
      state.holdUntil = ts + 1800;
    }
    for (const fn of hooks.advance) {
      try { t = fn(state.t, t, ts) ?? t; } catch (err) { console.error("extension (advance)", err); }
    }
    if (t >= d.frames.length - 1) { t = d.frames.length - 1; pause(); }
    state.t = t;
  }
  state.last = ts;
  if (d && !$("#analysis").hidden) render();
  requestAnimationFrame(tick);
}

function onFieldClick(e) {
  const v = GT.view, d = state.play;
  if (!v || !d) return;
  const r = e.target.getBoundingClientRect();
  const x = v.x0 + (e.clientX - r.left) / v.k, y = FIELD_W - (e.clientY - r.top) / v.k;
  const now = interp(state.t);
  let player = null, best = 2;
  for (const p of d.players) {
    const q = now.pos[p.id];
    const dist = q && Math.hypot(q[0] - x, q[1] - y);
    if (q && dist < best) { best = dist; player = p; }
  }
  // clic sur un receveur : on le sélectionne dans le tableau des options
  if (player?.route && state.options?.options?.some((o) => o.id === player.id)) {
    state.selOpt = player.id;
    renderOptions();
  }
  fire("click", { x, y, player });
}

// ------------------------------------------------------------------ dessin
const field = $("#field"), fctx = field.getContext("2d");
const tl = $("#timeline"), tctx = tl.getContext("2d");
// taille du terrain en pixels CSS (gardée ici : le canvas est masqué en vue 3D, clientWidth y vaut 0)
const fieldSize = { w: 0, h: 0 };

function sizeCanvas(cv, w, h) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resize() {
  // le terrain remplit la place disponible en gardant ses proportions
  const wrap = $("#fieldWrap");
  if (!wrap.clientWidth || !wrap.clientHeight) return;
  const ratio = VIEW_W / FIELD_W;
  let w = wrap.clientWidth, h = wrap.clientHeight;
  if (w / h > ratio) w = h * ratio; else h = w / ratio;
  fieldSize.w = Math.floor(w);
  fieldSize.h = Math.floor(h);
  sizeCanvas(field, fieldSize.w, fieldSize.h);
  sizeCanvas(tl, tl.parentElement.clientWidth - 24, 92);
  GT.render();
}

function interp(t) {
  const d = state.play;
  const i = Math.min(Math.floor(t), d.frames.length - 1);
  const j = Math.min(i + 1, d.frames.length - 1);
  const u = t - i, a = d.frames[i], b = d.frames[j];
  // x, y, vitesse interpolés ; orientation et direction prises sur l'image la plus proche
  const mix = (p, q) => (p && q
    ? [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, ...(p.length > 2 ? [p[2] + (q[2] - p[2]) * u, ...(u < 0.5 ? p : q).slice(3)] : [])]
    : p || q);
  const pos = {}, sep = {};
  for (const id in a.pos) pos[id] = mix(a.pos[id], b.pos[id]);
  for (const id in a.sep) sep[id] = a.sep[id] + ((b.sep[id] ?? a.sep[id]) - a.sep[id]) * u;
  const z = a.ballZ != null ? a.ballZ + ((b.ballZ ?? a.ballZ) - a.ballZ) * u : null;
  return { t, frame: i, pos, sep, ball: mix(a.ball, b.ball), ballZ: z, sim: !!a.sim, mostOpen: (u < 0.5 ? a : b).mostOpen };
}

function render() {
  const d = state.play;
  const W = fieldSize.w, H = fieldSize.h;
  if (!W) return;
  const x0 = d.los - 12, k = W / VIEW_W;
  const X = (x) => (x - x0) * k, Y = (y) => (FIELD_W - y) * k;
  const view = (GT.view = { X, Y, k, x0, W, H });
  const ctx = fctx;
  const now = interp(state.t);
  const afterSnap = state.t >= d.snapIdx;
  const atThrow = state.t >= d.passIdx;
  const reveal = atThrow && !state.hideHints;

  // terrain
  for (let x = Math.floor(x0 / 5) * 5; x < x0 + VIEW_W + 1; x += 5) {
    ctx.fillStyle = x < 10 || x >= 110 ? "#14532d" : (x / 5) % 2 ? "#2f7d32" : "#2b7330";
    ctx.fillRect(X(x), 0, 5 * k + 1, H);
    if (x >= 10 && x <= 110) {
      ctx.strokeStyle = `rgba(255,255,255,${x % 10 ? 0.25 : 0.6})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(x), 0); ctx.lineTo(X(x), H); ctx.stroke();
    }
    const yard = x - 10;
    if (x % 10 === 0 && yard > 0 && yard < 100) {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = `bold ${2.2 * k}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(String(Math.min(yard, 100 - yard)), X(x), Y(10));
      ctx.fillText(String(Math.min(yard, 100 - yard)), X(x), Y(42));
    }
  }
  line(ctx, X(d.los), H, "#60a5fa", 3);
  line(ctx, X(d.firstDown), H, "#fde047", 3);

  drawLayers("under", ctx, view, now, d);

  // traces des receveurs depuis le début de l'action
  const upto = Math.floor(state.t);
  for (const p of d.routes) {
    const isT = p.id === d.info.targetId, isO = p.id === d.info.openId;
    ctx.strokeStyle = reveal && isT ? COLORS.target : reveal && isO ? COLORS.open : "rgba(255,255,255,0.35)";
    ctx.lineWidth = reveal && (isT || isO) ? 2.5 : 1.5;
    ctx.beginPath();
    for (let i = d.snapIdx; i <= upto; i++) {
      const q = d.frames[i].pos[p.id];
      if (q) i === d.snapIdx ? ctx.moveTo(X(q[0]), Y(q[1])) : ctx.lineTo(X(q[0]), Y(q[1]));
    }
    const q = now.pos[p.id];
    if (q && upto >= d.snapIdx) ctx.lineTo(X(q[0]), Y(q[1]));
    ctx.stroke();
  }

  // cercles d'espace (jusqu'au lancer et pendant la fin des mesures)
  if (afterSnap && !state.hideHints && !now.sim) {
    for (const p of d.routes) {
      const q = now.pos[p.id], s = now.sep[p.id];
      if (!q || s == null) continue;
      const isOpenNow = p.id === now.mostOpen, isT = reveal && p.id === d.info.targetId;
      ctx.beginPath();
      ctx.arc(X(q[0]), Y(q[1]), s * k, 0, 2 * Math.PI);
      if (isOpenNow) { ctx.fillStyle = "rgba(250,204,21,0.15)"; ctx.fill(); }
      ctx.setLineDash(isOpenNow || isT ? [] : [3, 4]);
      ctx.strokeStyle = isT ? COLORS.target : isOpenNow ? COLORS.open : "rgba(255,255,255,0.7)";
      ctx.lineWidth = isOpenNow || isT ? 3 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // trajet du ballon depuis le lancer
  const qb = d.frames[d.passIdx]?.pos[d.passerId];
  if (atThrow && qb && now.ball) {
    ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 2; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(X(qb[0]), Y(qb[1])); ctx.lineTo(X(now.ball[0]), Y(now.ball[1])); ctx.stroke();
    ctx.setLineDash([]);
  }

  // joueurs (légèrement transparents pendant la suite simulée)
  ctx.globalAlpha = now.sim ? 0.8 : 1;
  for (const p of d.players) {
    const q = now.pos[p.id];
    if (!q) continue;
    ctx.beginPath();
    ctx.arc(X(q[0]), Y(q[1]), 0.85 * k, 0, 2 * Math.PI);
    ctx.fillStyle = p.side === "offense" ? COLORS.off : COLORS.def;
    ctx.fill();
    ctx.strokeStyle = "white"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "white";
    ctx.font = `bold ${0.95 * k}px system-ui`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(p.jersey, X(q[0]), Y(q[1]) + 1);
    ctx.textBaseline = "alphabetic";
  }
  ctx.globalAlpha = 1;

  // ballon (plus gros quand il est haut, avec son ombre au sol)
  if (now.ball) {
    const z = now.ballZ ?? 0, bx = X(now.ball[0]), by = Y(now.ball[1]);
    if (z > 0.3) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath(); ctx.ellipse(bx, by, 0.5 * k, 0.3 * k, 0, 0, 2 * Math.PI); ctx.fill();
    }
    const s = 1 + z / 8;
    ctx.beginPath();
    ctx.ellipse(bx, by - z * k * 0.25, 0.6 * k * s, 0.4 * k * s, 0, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.ball; ctx.fill();
    ctx.strokeStyle = "white"; ctx.lineWidth = 1; ctx.stroke();
  }

  // noms des receveurs + étiquettes au lancer
  for (const p of d.routes) {
    const q = now.pos[p.id];
    if (!q) continue;
    const isT = reveal && p.id === d.info.targetId, isO = reveal && p.id === d.info.openId && d.info.openId !== d.info.targetId;
    const sep = now.sim ? "" : ` (${num(now.sep[p.id] ?? 0)} yd)`;
    const label = isT ? `VISÉ : ${p.name}${sep}` : isO ? `LE PLUS LIBRE : ${p.name}${sep}` : lastName(p.name);
    tag(ctx, label, X(q[0]), Y(q[1]) - 1.3 * k, isT ? COLORS.target : isO ? COLORS.open : "white", isT || isO);
  }

  drawLayers("over", ctx, view, now, d);

  // bandeaux d'état
  const status = state.t < d.snapIdx ? "Avant le début de l'action" : now.sim ? "Suite simulée (fin des mesures)"
    : atThrow ? "Le ballon est lancé !" : "L'action est en cours";
  tag(ctx, status, 10, H - 10, now.sim ? "#cbd5e1" : atThrow ? COLORS.open : "white", true, "left");
  if (d.outcome && d.arrivalIdx != null && state.t >= d.arrivalIdx) banner(ctx, d.outcome.text, W / 2, H - 46, OUTCOME_COLORS[d.outcome.result]);

  // contrôles + chronologie
  $("#scrub").value = state.t;
  const secs = (state.t - d.snapIdx) / 10;
  $("#clock").textContent = (secs < 0 ? `${num(-secs)} s avant le début` : `${num(secs)} s après le début`) + (now.sim ? " · simulé" : "");
  renderTimeline();
  fire("render", ctx, view, now, d);
}

// calque intégré : une trajectoire par receveur, colorée selon le verdict du modèle Python
function drawPasses(ctx, v, now, d) {
  const o = state.options;
  if (!o?.options?.length || state.t < d.passIdx || state.hideHints) return;
  const start = d.frames[d.passIdx].pos[o.passerId ?? d.passerId];
  if (!start) return;
  for (const op of o.options) {
    const cp = op.catch;
    if (!cp) continue;
    const sel = state.selOpt ? op.id === state.selOpt : op.isTarget || op.isMostOpen;
    const col = VERDICT[op.verdict]?.color ?? "#fff";
    ctx.globalAlpha = sel ? 1 : 0.35;
    ctx.strokeStyle = col; ctx.lineWidth = sel ? 3 : 1.5; ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(v.X(start[0]), v.Y(start[1])); ctx.lineTo(v.X(cp[0]), v.Y(cp[1])); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(v.X(cp[0]), v.Y(cp[1]), 0.8 * v.k, 0, 2 * Math.PI); ctx.stroke();
    // détail (défenseur le plus rapide + étiquette) seulement pour la ligne choisie dans le tableau
    if (op.id === state.selOpt && op.defender) {
      const dp = d.frames[d.passIdx].pos[op.defender.id];
      if (dp) {
        ctx.strokeStyle = COLORS.def; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(v.X(dp[0]), v.Y(dp[1])); ctx.lineTo(v.X(cp[0]), v.Y(cp[1])); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      tag(ctx, `${lastName(op.name)} : ${VERDICT[op.verdict]?.label ?? ""} (${signed(op.margin)})`, v.X(cp[0]), v.Y(cp[1]) + 2.2 * v.k, col, true);
    }
  }
  ctx.globalAlpha = 1;
}

function drawLayers(z, ctx, view, now, d) {
  for (const l of layers) {
    if (!l.on || l.z !== z) continue;
    ctx.save();
    try { l.draw(ctx, view, now, d); } catch (err) { console.error(`calque ${l.id}`, err); }
    ctx.restore();
  }
}

function line(ctx, x, H, color, w) {
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
}

function tag(ctx, text, x, y, color, strong, align = "center") {
  ctx.font = `${strong ? "bold 14px" : "12px"} system-ui`;
  const w = ctx.measureText(text).width;
  // garde l'étiquette entière dans le terrain
  const left = Math.max(4, Math.min(align === "center" ? x - w / 2 : x, fieldSize.w - w - 6));
  y = Math.max(strong ? 16 : 14, y);
  ctx.fillStyle = "rgba(15,23,42,0.75)";
  ctx.fillRect(left - 4, y - (strong ? 14 : 12), w + 8, strong ? 19 : 16);
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.fillText(text, left, y);
}
GT.tag = tag;

function banner(ctx, text, x, y, color) {
  ctx.font = "bold 18px system-ui";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(11,18,32,0.88)";
  ctx.fillRect(x - w / 2 - 14, y - 22, w + 28, 34);
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.strokeRect(x - w / 2 - 14, y - 22, w + 28, 34);
  ctx.fillStyle = color; ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

// ------------------------------------------------------------------ chronologie de l'espace
function seriesColor(p) {
  const i = state.play.info;
  return p.id === i.targetId ? COLORS.target : p.id === i.openId ? COLORS.open : "#64748b";
}

function buildTimelineLegend() {
  $("#timelineLegend").innerHTML = state.play.routes
    .map((p) => `<span><i class="swatch" style="background:${seriesColor(p)}"></i>${lastName(p.name)} (${p.pos})</span>`)
    .join("");
}

function renderTimeline() {
  const d = state.play, ctx = tctx;
  const W = tl.clientWidth, H = tl.clientHeight, pad = { l: 34, r: 10, t: 12, b: 18 };
  const n = d.frames.length, yMax = 15;
  if (state.hideHints) {
    ctx.clearRect(0, 0, W, H);
    return;
  }
  const X = (i) => pad.l + ((i - d.snapIdx) / Math.max(1, n - 1 - d.snapIdx)) * (W - pad.l - pad.r);
  const Y = (s) => pad.t + (1 - Math.min(s, yMax) / yMax) * (H - pad.t - pad.b);
  ctx.clearRect(0, 0, W, H);

  // partie simulée grisée
  if (d.realEndIdx < n - 1) {
    ctx.fillStyle = "rgba(148,163,184,0.10)";
    ctx.fillRect(X(d.realEndIdx), pad.t, X(n - 1) - X(d.realEndIdx), H - pad.t - pad.b);
    ctx.fillStyle = "#94a3b8"; ctx.font = "10px system-ui"; ctx.textAlign = "center";
    ctx.fillText("suite simulée", (X(d.realEndIdx) + X(n - 1)) / 2, pad.t - 2);
  }

  ctx.fillStyle = "#94a3b8"; ctx.font = "10px system-ui"; ctx.textAlign = "right";
  for (const s of [0, 5, 10, 15]) {
    ctx.strokeStyle = "rgba(148,163,184,0.15)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(s)); ctx.lineTo(W - pad.r, Y(s)); ctx.stroke();
    ctx.fillText(`${s} yd`, pad.l - 4, Y(s) + 3);
  }
  ctx.textAlign = "center";
  for (let i = d.snapIdx; i < n; i += 10) ctx.fillText(`${(i - d.snapIdx) / 10} s`, X(i), H - 4);

  // ligne du lancer
  ctx.strokeStyle = COLORS.open; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(X(d.passIdx), pad.t); ctx.lineTo(X(d.passIdx), H - pad.b); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.open; ctx.fillText("lancer", X(d.passIdx), pad.t - 2);

  // une courbe par receveur (le visé et le plus libre par-dessus), mesures réelles seulement
  const grey = (p) => seriesColor(p) === "#64748b";
  for (const p of [...d.routes].sort((a, b) => grey(b) - grey(a))) {
    const c = seriesColor(p);
    ctx.strokeStyle = c; ctx.lineWidth = grey(p) ? 1.5 : 3;
    ctx.beginPath();
    let started = false;
    for (let i = d.snapIdx; i <= d.realEndIdx; i++) {
      const s = d.frames[i].sep[p.id];
      if (s == null) continue;
      started ? ctx.lineTo(X(i), Y(s)) : ctx.moveTo(X(i), Y(s));
      started = true;
    }
    ctx.stroke();
  }

  // curseur
  const cx = X(Math.max(state.t, d.snapIdx));
  ctx.strokeStyle = "white"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, H - pad.b); ctx.stroke();
}

init();
