"""Regard du lanceur : le joueur oublié était-il dans le champ de vision du lanceur juste avant le lancer ?

Champ de vision = orientation du lanceur (colonne `o`, angle horaire depuis +y) ± HALF_ANGLE.
"""
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache

import numpy as np
import pandas as pd
from flask import Blueprint, jsonify

import backend as b

c = b.c
bp = Blueprint("gaze", __name__, url_prefix="/api/gaze")

HALF_ANGLE = 30     # degrés de part et d'autre de l'orientation des épaules
WINDOW = 10         # images (1 seconde) avant le lancer
MIN_QB_GHOSTS = 12  # actions avec joueur oublié minimum pour le classement des lanceurs
CACHE = c.CACHE / "gaze_stats.pkl"


def angle_off(qx, qy, qo, px, py):
    """Écart (degrés) entre l'orientation du lanceur et la direction du joueur."""
    bearing = np.degrees(np.arctan2(px - qx, py - qy))
    return np.abs((bearing - qo + 540) % 360 - 180)


def game_rows(args):
    game_id, plays = args
    t = c.read_tracking_file(game_id)
    t = t[t.playId.isin(plays.playId)]
    frames = c.play_frames(t).dropna(subset=["pass_frame"]).set_index("playId").pass_frame
    rows = []
    for (pid, w) in t.groupby("playId"):
        if pid not in frames.index:
            continue
        pf = frames[pid]
        w = w[w.frameId.between(pf - WINDOW, pf)]
        r = plays[plays.playId == pid].iloc[0]
        qb = w[w.nflId == r.passer_nflId].set_index("frameId")[["x", "y", "o"]]
        out = {"gameId": game_id, "playId": pid}
        for key, nid in (("open", r.nflId_open), ("tgt", r.nflId_tgt)):
            j = qb.join(w[w.nflId == nid].set_index("frameId")[["x", "y"]], rsuffix="_p", how="inner")
            off = angle_off(j.x, j.y, j.o, j.x_p, j.y_p)
            out[f"{key}_frames"] = int((off <= HALF_ANGLE).sum())
            out[f"{key}_at_throw"] = bool(off.get(pf, 999) <= HALF_ANGLE)
        rows.append(out)
    return rows


def compute():
    pl, _ = b.data()
    pas = pl.dropna(subset=["passer_nflId"])[["gameId", "playId", "passer_nflId", "nflId_open", "nflId_tgt"]]
    with ProcessPoolExecutor(8) as ex:
        parts = ex.map(game_rows, list(pas.groupby("gameId")))
        rows = [r for part in parts for r in part]
    return pd.DataFrame(rows).merge(pl[["gameId", "playId", "qb", "ghost", "hit_most_open"]], on=["gameId", "playId"])


@lru_cache
def table():
    if CACHE.exists():
        return pd.read_pickle(CACHE)
    df = compute()
    df.to_pickle(CACHE)
    return df


@bp.get("/stats")
def stats():
    df = table()
    gh = df[df.ghost]
    qbs = (gh.assign(never=gh.open_frames == 0).groupby("qb")
             .agg(ghosts=("never", "size"), never=("never", "mean"))
             .query("ghosts >= @MIN_QB_GHOSTS").sort_values("never", ascending=False))
    return jsonify(halfAngle=HALF_ANGLE, windowSec=WINDOW / 10, ghostPlays=len(gh),
                   neverLooked=float((gh.open_frames == 0).mean()),
                   openAtThrow=float(gh.open_at_throw.mean()),
                   targetAtThrow=float(df.tgt_at_throw.mean()),
                   qbs=[{"qb": q, "ghosts": int(r.ghosts), "never": float(r.never)} for q, r in qbs.iterrows()])
