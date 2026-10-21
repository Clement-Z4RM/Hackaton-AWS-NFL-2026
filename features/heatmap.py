"""Extension « Où sont les joueurs oubliés ? » : cartes de chaleur des positions au lancer, relatives à la ligne de départ.

y élevé = côté gauche de l'attaque (l'attaque va vers les x croissants).
"""
from functools import lru_cache

import numpy as np
import pandas as pd
from flask import Blueprint, jsonify, request
from scipy.ndimage import gaussian_filter

import backend as b
from backend import c

bp = Blueprint("heatmap", __name__, url_prefix="/api/heatmap")

FIELD_W = 53.3
DEPTH_EDGES = np.arange(-5, 40.01, 2.5)       # yards au-delà de la ligne de départ
WIDTH_EDGES = np.linspace(0, FIELD_W, 21)     # ~2,7 yd par case
SMOOTH = 1.0                                  # lissage gaussien, en cases
BAND_EDGES = [-np.inf, 0, 10, 20, 30, np.inf]
BAND_LABELS = ["derrière la ligne", "à 0-10 yd", "à 10-20 yd", "à 20-30 yd", "à plus de 30 yd"]


@lru_cache
def points():
    """Positions au lancer : (joueurs oubliés, joueurs visés), une ligne par action."""
    pl, _ = b.data()
    rec = c.receivers_at_throw()[["gameId", "playId", "nflId", "y", "depth"]]
    keys = ["gameId", "playId"]
    base = pl[keys + ["ghost", "possessionTeam", "qb", "nflId_open", "nflId_tgt"]]
    cols = ["possessionTeam", "qb", "y", "depth"]
    ghost = base[base.ghost].merge(rec, left_on=keys + ["nflId_open"], right_on=keys + ["nflId"])[cols]
    target = base.merge(rec, left_on=keys + ["nflId_tgt"], right_on=keys + ["nflId"])[cols]
    return ghost, target


def _filter(df, team, qb):
    if team:
        df = df[df.possessionTeam == team]
    if qb:
        df = df[df.qb == qb]
    return df


def _hist(df):
    h, _, _ = np.histogram2d(df.depth, df.y, bins=[DEPTH_EDGES, WIDTH_EDGES])
    return gaussian_filter(h, SMOOTH, mode="constant")


def _zones(df):
    band = pd.cut(df.depth, BAND_EDGES, labels=BAND_LABELS)
    side = np.select([df.y >= FIELD_W * 2 / 3, df.y <= FIELD_W / 3], ["côté gauche", "côté droit"], "au milieu")
    return pd.DataFrame({"band": band.astype(str), "side": side})


def describe(g_pts, t_pts, mode, who):
    if len(g_pts) < 10:
        return f"Pas assez de joueurs oubliés {who}pour conclure ({len(g_pts)} actions)."
    if mode == "target":
        z = _zones(t_pts)
        band, side = z.band.value_counts(normalize=True), z.side.value_counts(normalize=True)
        return (f"Les passes {who}vont surtout {band.index[0]} ({band.iloc[0] * 100:.0f} %), "
                f"{side.index[0]} ({side.iloc[0] * 100:.0f} %).")
    zg = _zones(g_pts)
    if mode == "ratio":
        zt = _zones(t_pts)
        sg = zg.value_counts()
        share = (sg / len(zg)) / (zt.value_counts(normalize=True).reindex(sg.index).fillna(0) + 0.01)
        share = share[sg >= max(5, len(zg) * 0.05)]
        if share.empty:
            return f"Pas assez de joueurs oubliés {who}pour comparer."
        (band, side), r = share.idxmax(), share.max()
        ratio = f"{r:.1f}".replace(".", ",")
        return (f"Par rapport aux passes réellement lancées {who}".rstrip()
                + f", les joueurs oubliés sont surtout {band}, {side} : {ratio} fois plus qu'attendu.")
    band, side = zg.band.value_counts(normalize=True), zg.side.value_counts(normalize=True)
    return (f"Les joueurs oubliés {who}sont surtout {band.index[0]} ({band.iloc[0] * 100:.0f} %), "
            f"{side.index[0]} ({side.iloc[0] * 100:.0f} %).")


@bp.get("/grid")
def grid():
    team, qb = request.args.get("team") or None, request.args.get("qb") or None
    mode = request.args.get("mode", "ghost")
    g_pts, t_pts = (_filter(d, team, qb) for d in points())
    g, t = _hist(g_pts), _hist(t_pts)
    if mode == "ratio":
        gs, ts = g / max(g.sum(), 1e-9), t / max(t.sum(), 1e-9)
        eps = 0.15 / g.size
        val = np.log2((gs + eps) / (ts + eps)).clip(-2, 2)
        val[(gs + ts) < 0.3 / g.size] = np.nan     # cases sans données : rien à dire
        vmax = 2.0
    else:
        val = g if mode == "ghost" else t
        vmax = float(val.max())
    who = f"de {qb} " if qb else f"de {team} " if team else ""
    return jsonify(mode=mode, team=team, qb=qb, depthEdges=DEPTH_EDGES.tolist(),
                   widthEdges=WIDTH_EDGES.round(3).tolist(),
                   grid=[[None if np.isnan(v) else round(float(v), 4) for v in row] for row in val],
                   vmax=vmax, nGhost=len(g_pts), nTarget=len(t_pts), sentence=describe(g_pts, t_pts, mode, who))
