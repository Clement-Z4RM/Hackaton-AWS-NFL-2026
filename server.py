"""Backend Python du « Joueur oublié » : `.venv/bin/python server.py [port]` puis http://localhost:5000

Sert le site (web/) et une API JSON. Chaque extension ajoute un fichier features/<nom>.py qui expose
`bp` (un Blueprint Flask, routes sous /api/<nom>/...) et un fichier web/features/<nom>.js : les deux sont
chargés automatiquement.
"""
import importlib
import io
from pathlib import Path
import re
import sys
import traceback

from flask import Flask, jsonify, request
import pandas as pd

import backend as b

c = b.c
app = Flask(__name__, static_folder=str(b.ROOT / "web"), static_url_path="")

TRACK_RE = re.compile(r"tracking_(\d+)\.csv$")
TRACK_COLS = {"gameId", "playId", "nflId", "frameId", "team", "playDirection", "x", "y", "s", "a", "o", "dir", "event"}
META_KEYS = {"games.csv": ["gameId"], "plays.csv": ["gameId", "playId"], "players.csv": ["nflId"],
             "pffScoutingData.csv": ["gameId", "playId", "nflId"]}


@app.get("/")
def index():
    return app.send_static_file("index.html")


FEATURE_ORDER = ["qb_view", "free_time", "gaze", "zones", "heatmap"]


@app.get("/api/features")
def features():
    names = [f.stem for f in (b.ROOT / "web" / "features").glob("*.js")]
    rank = {n: i for i, n in enumerate(FEATURE_ORDER)}
    return jsonify([f"{n}.js" for n in sorted(names, key=lambda n: (rank.get(n, len(rank)), n))])


@app.get("/api/summary")
def summary():
    pl, _ = b.data()
    comp = pl.groupby("hit_most_open").complete.mean()
    yds = pl.groupby("hit_most_open").playResult.mean()
    return jsonify(passes=len(pl), notMostOpen=float(1 - pl.hit_most_open.mean()),
                   ghostRate=float(pl.ghost.mean()), ghostPlays=int(pl.ghost.sum()),
                   compOpen=float(comp[True]), compOther=float(comp[False]),
                   yardsOpen=float(yds[True]), yardsOther=float(yds[False]),
                   teams=sorted(pl.possessionTeam.unique().tolist()))


@app.get("/api/games")
def games_list():
    pl, _ = b.data()
    counts = pl.groupby("gameId").agg(passes=("ghost", "size"), ghosts=("ghost", "sum"))
    g = c.games().merge(counts, left_on="gameId", right_index=True).sort_values(["week", "gameDate", "gameId"])
    return jsonify([{"gameId": int(r.gameId), "week": int(r.week), "home": r.homeTeamAbbr, "visitor": r.visitorTeamAbbr,
                     "date": r.gameDate, "passes": int(r.passes), "ghosts": int(r.ghosts)} for r in g.itertuples()])


def reset_caches():
    """Uploaded data changed: drop every derived table (pickles + in-memory lru caches)."""
    for p in c.CACHE.glob("*.pkl"):
        p.unlink()
    for mod in list(sys.modules.values()):
        name = getattr(mod, "__name__", "") or ""
        if name in ("common", "backend", "ghost_targets", "passing") or name.startswith("features."):
            for v in list(vars(mod).values()):
                if callable(getattr(v, "cache_clear", None)):
                    v.cache_clear()


@app.post("/api/upload")
def upload():
    """Drag & drop: tracking_<gameId>.csv files and/or games/plays/players/pffScoutingData.csv to merge."""
    files = request.files.getlist("files")
    if not files:
        return jsonify(error="Aucun fichier reçu."), 400
    games, warnings, changed = [], [], False
    for f in files:
        name, content = Path(f.filename).name, f.read()
        try:
            head = pd.read_csv(io.BytesIO(content), nrows=50)
        except Exception:
            warnings.append(f"{name} : ce n'est pas un fichier CSV lisible.")
            continue
        if m := TRACK_RE.search(name):
            if missing := TRACK_COLS - set(head.columns):
                warnings.append(f"{name} : colonnes manquantes ({', '.join(sorted(missing))}).")
                continue
            path = c.DATA / "tracking" / name
            if not path.exists() or path.read_bytes() != content:
                path.write_bytes(content)
                changed = True
            games.append(int(m.group(1)))
        elif name in META_KEYS:
            keys = META_KEYS[name]
            if not set(keys) <= set(head.columns):
                warnings.append(f"{name} : colonnes clés manquantes ({', '.join(keys)}).")
                continue
            old = pd.read_csv(c.DATA / name)
            merged = pd.concat([old, pd.read_csv(io.BytesIO(content))]).drop_duplicates(keys, keep="last")
            if len(merged) != len(old):
                merged.to_csv(c.DATA / name, index=False)
                changed = True
        else:
            warnings.append(f"{name} : fichier non reconnu (attendu : tracking_<match>.csv, games.csv, plays.csv, "
                            "players.csv ou pffScoutingData.csv).")
    if changed:
        reset_caches()
        b.data()
    known = set(b.data()[0].gameId)
    for g in games:
        if g not in known:
            warnings.append(f"Match {g} : positions reçues, mais il manque ses actions. Ajoutez aussi games.csv, "
                            "plays.csv, players.csv et pffScoutingData.csv de ce match.")
    return jsonify(games=[g for g in games if g in known], warnings=warnings, recomputed=changed)


@app.get("/api/plays")
def plays_list():
    pl, _ = b.data()
    sub = pl
    if game := request.args.get("game"):
        sub = sub[sub.gameId == int(game)]
    if team := request.args.get("team"):
        sub = sub[sub.possessionTeam == team]
    if player := request.args.get("player"):
        sub = sub[sub.nflId_open == float(player)]
    if request.args.get("ghost", "1") == "1":
        sub = sub[sub.ghost]
    # un match choisi : ordre chronologique ; sinon les oublis les plus flagrants d'abord
    sub = (sub.sort_values("playId") if game else sub.sort_values("sep_open", ascending=False)).head(300)
    return jsonify([b.play_row(r) for r in sub.itertuples()])


@app.get("/api/ranking")
def ranking():
    _, rk = b.data()
    pos = request.args.get("pos", "WR,TE,RB").split(",")
    rk = rk[rk.officialPosition.isin(pos)].head(20)
    return jsonify([{"nflId": int(r.nflId), "name": r.displayName, "pos": r.officialPosition, "team": r.team,
                     "ghosts": int(r.ghosts), "routes": int(r.routes), "rate": float(r.ghost_rate)}
                    for r in rk.itertuples()])


@app.get("/api/play/<int:game_id>/<int:play_id>")
def play_detail(game_id, play_id):
    return jsonify(b.play_payload(game_id, play_id))


def register_features():
    """One broken extension must not take the whole site down."""
    for f in sorted((b.ROOT / "features").glob("[!_]*.py")):
        try:
            app.register_blueprint(importlib.import_module(f"features.{f.stem}").bp)
        except Exception:
            print(f"[extension ignorée] {f.name}\n{traceback.format_exc()}", file=sys.stderr)


register_features()

if __name__ == "__main__":
    b.data()  # préchargement (quelques secondes)
    app.run(port=int(sys.argv[1]) if len(sys.argv) > 1 else 5000, debug=False)
