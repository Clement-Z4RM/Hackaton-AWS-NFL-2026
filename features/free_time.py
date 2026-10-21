"""« Temps libre ignoré » : depuis combien de temps le joueur le plus libre était seul quand le ballon est parti."""
from functools import lru_cache

import numpy as np
import pandas as pd
from flask import Blueprint, jsonify

import backend as b
from backend import c

bp = Blueprint("free_time", __name__, url_prefix="/api/free_time")

CACHE = c.CACHE / "free_time.pkl"
OPEN_YDS = 5.0       # même seuil que « joueur seul » dans ghost_targets
CHUNK = 12           # matchs chargés à la fois (RAM)
MIN_GHOSTS = 3       # actions « oublié » minimum pour le classement des joueurs
TOP = 8


def _route_seps(track):
    """Distance au défenseur le plus proche, par coureur de route et par image, du snap au lancer."""
    frames = c.play_frames(track).dropna(subset=["snap_frame", "pass_frame"])
    t = c.add_sides(track).merge(frames[["gameId", "playId", "snap_frame", "pass_frame"]], on=["gameId", "playId"])
    t = t[(t.frameId >= t.snap_frame) & (t.frameId <= t.pass_frame)]
    routes = c.pff().query("pff_role == 'Pass Route'")[["gameId", "playId", "nflId"]]
    off = t.merge(routes, on=["gameId", "playId", "nflId"])[["gameId", "playId", "frameId", "nflId", "x", "y"]]
    dfn = t[t.side == "defense"][["gameId", "playId", "frameId", "x", "y"]]
    m = off.merge(dfn, on=["gameId", "playId", "frameId"], suffixes=("", "_d"))
    m["d"] = np.hypot(m.x - m.x_d, m.y - m.y_d)
    return m.groupby(["gameId", "playId", "nflId", "frameId"]).d.min().reset_index()


def _streaks(seps):
    """Par (action, joueur) : secondes seul d'affilée juste avant le lancer, et secondes seul au total."""
    seps["free"] = seps.d >= OPEN_YDS
    g = seps.groupby(["gameId", "playId", "nflId"])
    out = pd.DataFrame({"last_frame": g.frameId.max(), "first_frame": g.frameId.min(), "total": g.free.sum() / 10})
    last_busy = seps[~seps.free].groupby(["gameId", "playId", "nflId"]).frameId.max()
    out["streak"] = (out.last_frame - last_busy.reindex(out.index)).fillna(out.last_frame - out.first_frame + 1) / 10
    return out[["streak", "total"]].reset_index()


@lru_cache
def table():
    """Une ligne par passe : temps seul du plus libre au lancer et du joueur visé (cache pickle)."""
    if CACHE.exists():
        return pd.read_pickle(CACHE)
    ids = c.game_ids()
    parts = []
    for i in range(0, len(ids), CHUNK):
        parts.append(_streaks(_route_seps(c.load_tracking(ids[i:i + CHUNK]))))
    st = pd.concat(parts, ignore_index=True)
    pl, _ = b.data()
    keep = ["gameId", "playId", "ghost", "qb", "passer_nflId", "possessionTeam",
            "nflId_open", "displayName_open", "officialPosition", "nflId_tgt", "displayName_tgt"]
    tab = (pl[keep]
           .merge(st.rename(columns={"nflId": "nflId_open", "streak": "open_streak", "total": "open_total"}),
                  on=["gameId", "playId", "nflId_open"], how="left")
           .merge(st.rename(columns={"nflId": "nflId_tgt", "streak": "tgt_streak", "total": "tgt_total"}),
                  on=["gameId", "playId", "nflId_tgt"], how="left"))
    tab[["open_streak", "open_total", "tgt_streak", "tgt_total"]] = \
        tab[["open_streak", "open_total", "tgt_streak", "tgt_total"]].fillna(0)
    tab.to_pickle(CACHE)
    return tab


def _top(gh, key, name, extra):
    agg = gh.groupby([key, name] + extra).agg(seconds=("open_streak", "sum"), plays=("open_streak", "size"))
    worst = gh.loc[gh.groupby(key).open_streak.idxmax(), [key, "gameId", "playId", "open_streak"]].set_index(key)
    agg = agg.reset_index().join(worst, on=key)
    return agg


@bp.get("/play/<int:game_id>/<int:play_id>")
def play(game_id, play_id):
    tab = table()
    r = tab[(tab.gameId == game_id) & (tab.playId == play_id)]
    if r.empty:
        return jsonify(error="action inconnue")
    r = r.iloc[0]
    return jsonify(open=r.displayName_open, openStreak=round(float(r.open_streak), 1),
                   openTotal=round(float(r.open_total), 1), target=r.displayName_tgt,
                   targetStreak=round(float(r.tgt_streak), 1), targetTotal=round(float(r.tgt_total), 1),
                   same=bool(r.nflId_open == r.nflId_tgt), ghost=bool(r.ghost))


@bp.get("/ranking")
def ranking():
    tab = table()
    gh = tab[tab.ghost]
    team = c.players().set_index("nflId")
    pl = _top(gh, "nflId_open", "displayName_open", ["officialPosition", "possessionTeam"])
    pl = pl[pl.plays >= MIN_GHOSTS].sort_values("seconds", ascending=False).head(TOP)
    qb = _top(gh, "passer_nflId", "qb", ["possessionTeam"]).sort_values("seconds", ascending=False).head(TOP)

    def rows(df, key, name):
        return [{"id": int(r[key]), "name": r[name], "team": r.possessionTeam,
                 "pos": r.get("officialPosition", team.officialPosition.get(r[key], "")),
                 "seconds": round(float(r.seconds), 1), "plays": int(r.plays),
                 "worst": {"gameId": int(r.gameId), "playId": int(r.playId), "streak": round(float(r.open_streak), 1)}}
                for _, r in df.iterrows()]

    return jsonify(players=rows(pl, "nflId_open", "displayName_open"), qbs=rows(qb, "passer_nflId", "qb"),
                   summary={"ghostPlays": int(len(gh)), "medianStreak": round(float(gh.open_streak.median()), 1),
                            "over1s": float((gh.open_streak >= 1).mean()),
                            "targetMedian": round(float(gh.tgt_streak.median()), 1)})
