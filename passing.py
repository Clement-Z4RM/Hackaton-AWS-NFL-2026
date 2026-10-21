"""« La passe était-elle possible ? » : course entre le ballon et les défenseurs, par action et sur toutes les passes.

Hypothèses (réglables) : ballon en ligne droite à 20 yd/s, passe « en avance » sur la course du receveur
(il continue tout droit à sa vitesse actuelle), défenseurs à 8 yd/s (ou plus s'ils courent déjà plus vite)
après 0,3 s de réaction. Marge = arrivée du premier défenseur − arrivée du ballon.
"""
from functools import lru_cache

import numpy as np
import pandas as pd

import common as c

BALL_SPEED = 20.0
DEF_SPEED = 8.0
REACTION = 0.3
GAZE_HALF_ANGLE = 30.0
ALONE_YDS = 5.0
CACHE = c.CACHE / "passing_options.pkl"

VERDICT_LABEL = {"possible": "Possible", "serree": "Serrée", "contestee": "Contestée"}
VERDICT_WORD = {"possible": "possible", "serree": "serrée", "contestee": "contestée"}


def velocity(s, direction):
    """NGS convention (normalized coords): angle clockwise from +y."""
    rad = np.radians(direction)
    return s * np.sin(rad), s * np.cos(rad)


def lead_point(qx, qy, rx, ry, vx, vy, ball_speed=BALL_SPEED, iters=10):
    """Where a ball thrown from (qx, qy) meets a receiver running straight on (flight time == receiver time)."""
    t = np.hypot(rx - qx, ry - qy) / ball_speed
    for _ in range(iters):
        px = np.clip(rx + vx * t, 0.5, 119.5)
        py = np.clip(ry + vy * t, 0.5, 52.8)
        t = np.hypot(px - qx, py - qy) / ball_speed
    return px, py, t


def defender_times(dx, dy, ds, px, py, def_speed=DEF_SPEED, reaction=REACTION):
    return reaction + np.hypot(dx - px, dy - py) / np.maximum(def_speed, ds)


EXTRA_LEAD = np.arange(0, 1.01, 0.1)   # le lanceur peut viser jusqu'à 1 s plus loin sur la course (ballon plus lobé)


def best_catch(tx, ty, rx, ry, vx, vy, dx, dy, ds, ball_speed=BALL_SPEED, def_speed=DEF_SPEED, reaction=REACTION):
    """Best catch point on the receiver's straight run, for one or many receivers (arrays of shape (n,)).

    Candidates: the pure lead point (fastest ball), then up to 1 s further along the run (the ball can be
    lofted to arrive with the receiver). Margin = first defender arrival − ball/receiver arrival; keep the best.
    Returns px, py, arrival time, index of the first defender, his arrival time, margin.
    """
    rx, ry, vx, vy = (np.atleast_1d(np.asarray(a, float)) for a in (rx, ry, vx, vy))
    _, _, t0 = lead_point(tx, ty, rx, ry, vx, vy, ball_speed)
    t = t0[:, None] + EXTRA_LEAD[None, :]                                    # (n, k)
    px = np.clip(rx[:, None] + vx[:, None] * t, 0.5, 119.5)
    py = np.clip(ry[:, None] + vy[:, None] * t, 0.5, 52.8)
    tdef = reaction + np.hypot(dx[None, None, :] - px[..., None], dy[None, None, :] - py[..., None]) \
        / np.maximum(def_speed, ds)[None, None, :]                           # (n, k, d)
    first = tdef.argmin(axis=2)
    tfirst = np.take_along_axis(tdef, first[..., None], axis=2)[..., 0]
    margin = tfirst - t
    best = margin.argmax(axis=1)
    pick = lambda a: np.take_along_axis(a, best[:, None], axis=1)[:, 0]  # noqa: E731
    return pick(px), pick(py), pick(t), pick(first), pick(tfirst), pick(margin)


def verdict(margin):
    return "possible" if margin >= 0.5 else "serree" if margin >= 0 else "contestee"


def bearing(qx, qy, x, y):
    return np.degrees(np.arctan2(x - qx, y - qy)) % 360


def angle_diff(a, b):
    return np.abs((a - b + 180) % 360 - 180)


def _fmt(x):
    return f"{x:.1f}".replace(".", ",")


def margin_text(m):
    if abs(m) < 0.05:
        return "le ballon et le défenseur arrivent en même temps"
    return f"{_fmt(m)} s d'avance sur la défense" if m >= 0 else f"un défenseur pouvait arriver {_fmt(-m)} s avant le ballon"


def where(o):
    return "derrière la ligne" if o["depth"] < 0 else f"à {o['depth']:.0f} yd au-delà de la ligne"


def _frame_index(frames, frame_no):
    return next((i for i, f in enumerate(frames) if f["frame"] == frame_no), None)


# ---------------------------------------------------------------- une action
def option_table(d, ball_speed=BALL_SPEED, def_speed=DEF_SPEED, reaction=REACTION):
    """Every route runner at the throw: catch point, flight time, first defender to arrive, margin, verdict."""
    frames = d["frames"]
    pi = _frame_index(frames, d["passFrame"]) if d.get("passFrame") is not None else None
    passer = d.get("passerId")
    out = {"passerId": passer, "throwIdx": pi, "options": [], "summary": "Pas de passe sur cette action."}
    if pi is None or passer is None or passer not in frames[pi]["pos"]:
        return out

    f = frames[pi]
    pos = f["pos"]
    qx, qy, _, qo, _ = pos[passer]
    tx, ty = f["ball"] if f["ball"] else (qx, qy)
    defenders = [p for p in d["players"] if p["side"] == "defense" and p["id"] in pos]
    dpos = np.array([pos[p["id"]][:3] for p in defenders])
    si = _frame_index(frames, d["snapFrame"]) or 0
    info = d.get("info") or {}

    opts = []
    for p in d["players"]:
        if not p["route"] or p["id"] not in pos:
            continue
        rx, ry, s, _, direction = pos[p["id"]]
        vx, vy = velocity(s, direction)
        px, py, flight, j, tj, margin = (a[0] for a in best_catch(
            tx, ty, rx, ry, vx, vy, dpos[:, 0], dpos[:, 1], dpos[:, 2], ball_speed, def_speed, reaction))
        j, margin = int(j), float(margin)
        alone = 0
        for k in range(pi, si - 1, -1):
            if frames[k]["sep"].get(p["id"], 0) >= ALONE_YDS:
                alone += 1
            else:
                break
        dfn = defenders[j]
        opts.append({
            "id": p["id"], "name": p["name"], "pos": p["pos"], "jersey": p["jersey"],
            "catch": [round(float(px), 2), round(float(py), 2)], "flight": round(float(flight), 2),
            "defender": {"id": dfn["id"], "name": dfn["name"], "jersey": dfn["jersey"], "time": round(float(tj), 2)},
            "margin": round(margin, 2), "verdict": verdict(margin), "verdictLabel": VERDICT_LABEL[verdict(margin)],
            "sep": round(float(f["sep"].get(p["id"], 0)), 2), "depth": round(float(rx - d["los"]), 1),
            "alone": round(alone / 10, 1),
            "inGaze": bool(angle_diff(bearing(qx, qy, rx, ry), qo) <= GAZE_HALF_ANGLE),
            "isTarget": p["id"] == info.get("targetId"),
            "isMostOpen": p["id"] == info.get("openId", f.get("mostOpen")),
        })
    opts.sort(key=lambda o: -o["margin"])
    out.update(options=opts, summary=summary(opts))
    return out


def summary(opts):
    if not opts:
        return "Aucun receveur à analyser sur cette action."
    tgt = next((o for o in opts if o["isTarget"]), None)
    opn = next((o for o in opts if o["isMostOpen"]), None)
    best = opts[0]
    parts = []
    if opn and (not tgt or opn["id"] != tgt["id"]):
        parts.append(f"La passe à {opn['name']} était {VERDICT_WORD[opn['verdict']]} ({margin_text(opn['margin'])}).")
    if tgt:
        who = "le joueur le plus libre, " if opn and opn["id"] == tgt["id"] else ""
        parts.append(f"Le lanceur a choisi {who}{tgt['name']} : passe {VERDICT_WORD[tgt['verdict']]} "
                     f"({margin_text(tgt['margin'])}).")
    if best is not tgt and best is not opn:
        if best["verdict"] == "contestee":
            parts.append(f"Aucune passe n'était vraiment ouverte ; la moins risquée : {best['name']} ({where(best)}).")
        else:
            parts.append(f"Meilleure option selon le modèle : {best['name']}, {where(best)} "
                         f"({margin_text(best['margin'])}).")
    return " ".join(parts)


# ---------------------------------------------------------------- toutes les passes
def _play_rows(g, p, grp, passer_id):
    q = grp[grp.nflId == passer_id]
    rr = grp[grp.route]
    dd = grp[grp.side == "defense"]
    if q.empty or rr.empty or dd.empty:
        return None
    ball = grp[grp.side == "football"]
    tx, ty = (ball.x.iloc[0], ball.y.iloc[0]) if len(ball) else (q.x.iloc[0], q.y.iloc[0])
    vx, vy = velocity(rr.s.values, rr.dir.values)
    _, _, flight, _, _, margin = best_catch(tx, ty, rr.x.values, rr.y.values, vx, vy,
                                            dd.x.values, dd.y.values, dd.s.values)
    return pd.DataFrame({"gameId": g, "playId": p, "nflId": rr.nflId.values, "flight": flight, "margin": margin})


def batch():
    """Option table (margin + verdict) for every route runner of every pass, at the throw (cached)."""
    if CACHE.exists():
        return pd.read_pickle(CACHE)
    import backend as b
    snap = c.pass_snapshot()
    routes = c.pff().query("pff_role == 'Pass Route'")[["gameId", "playId", "nflId"]].assign(route=True)
    snap = snap.merge(routes, on=["gameId", "playId", "nflId"], how="left")
    snap["route"] = snap.route.fillna(False).astype(bool)
    passer = b.passers().set_index(["gameId", "playId"]).passer_nflId
    parts = []
    for (g, p), grp in snap.groupby(["gameId", "playId"], sort=False):
        if (g, p) in passer.index:
            rows = _play_rows(g, p, grp, passer[(g, p)])
            if rows is not None:
                parts.append(rows)
    out = pd.concat(parts, ignore_index=True)
    out["verdict"] = np.select([out.margin >= 0.5, out.margin >= 0], ["possible", "serree"], "contestee")
    out.to_pickle(CACHE)
    return out


@lru_cache
def validation():
    """Does the model agree with real outcomes? + how often the forgotten player was a possible pass."""
    import backend as b
    opt = batch()
    pl, _ = b.data()
    tg = opt.merge(pl[["gameId", "playId", "nflId_tgt", "passResult"]],
                   left_on=["gameId", "playId", "nflId"], right_on=["gameId", "playId", "nflId_tgt"])
    by = tg.groupby("verdict").agg(passes=("nflId", "size"),
                                   completion=("passResult", lambda s: float((s == "C").mean())))
    by_verdict = [{"verdict": v, "label": VERDICT_LABEL[v], "passes": int(by.passes[v]),
                   "completion": round(by.completion[v], 4)} for v in ["possible", "serree", "contestee"] if v in by.index]
    gh = opt.merge(pl[pl.ghost][["gameId", "playId", "nflId_open", "nflId_tgt"]],
                   left_on=["gameId", "playId", "nflId"], right_on=["gameId", "playId", "nflId_open"])
    ghost_possible = float((gh.verdict == "possible").mean())
    ghost_tight = float((gh.verdict == "serree").mean())
    # le joueur oublié offrait-il une meilleure marge que la passe réellement choisie ?
    gh = gh.merge(opt[["gameId", "playId", "nflId", "margin"]].rename(columns={"nflId": "nflId_tgt", "margin": "margin_tgt"}),
                  on=["gameId", "playId", "nflId_tgt"], how="left")
    ghost_better = float((gh.margin > gh.margin_tgt).mean())
    comp = {r["verdict"]: r["completion"] for r in by_verdict}
    pct = lambda x: f"{round(x * 100)} %"  # noqa: E731
    coherent = comp.get("possible", 0) > comp.get("contestee", 1)
    text = (f"{'Le modèle colle aux vrais résultats' if coherent else 'Attention, le modèle colle mal aux vrais résultats'} : "
            f"une passe jugée possible est réussie {pct(comp.get('possible', 0))} du temps, contre "
            f"{pct(comp.get('contestee', 0))} quand elle est contestée. Sur les actions avec un joueur oublié, la passe "
            f"vers lui était possible dans {pct(ghost_possible)} des cas et serrée dans {pct(ghost_tight)}, et elle "
            f"offrait plus de marge que la passe choisie dans {pct(ghost_better)} des cas.")
    return {"byVerdict": by_verdict, "ghostPossible": round(ghost_possible, 4), "ghostTight": round(ghost_tight, 4),
            "ghostBetter": round(ghost_better, 4), "ghostPlays": int(len(gh)), "text": text}
