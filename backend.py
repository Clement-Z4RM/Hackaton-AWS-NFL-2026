"""Shared data for the web backend (server.py and the feature blueprints in features/)."""
import copy
from functools import lru_cache
import math
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "prototypes"))
import common as c  # noqa: E402
import ghost_targets as gt  # noqa: E402
import passing  # noqa: E402

RESULT = {"C": "réussie", "I": "ratée", "IN": "interceptée"}
OUTCOME_EVENT = {"C": "pass_outcome_caught", "I": "pass_outcome_incomplete", "IN": "pass_outcome_interception"}
SIM_DECEL = 0.93       # vitesse × 0,93 par image simulée
SIM_AFTER = 6          # images simulées après l'arrivée du ballon (0,6 s)
BALL_Z0, BALL_Z1, GRAVITY = 2.0, 1.5, 10.7   # hauteur au lancer / à l'arrivée (yd), gravité (yd/s²)


@lru_cache
def data():
    """Passes (visé vs plus libre au lancer) + classement des joueurs oubliés."""
    rec = c.receivers_at_throw()
    pl = gt.build_plays(rec)
    pl = (pl.merge(c.plays()[["gameId", "playId", "possessionTeam", "defensiveTeam", "quarter", "playDescription"]],
                   on=["gameId", "playId"])
            .merge(passers(), on=["gameId", "playId"], how="left"))
    return pl, gt.player_ranking(rec, pl)


@lru_cache
def passers():
    """gameId, playId, passer_nflId, qb (name)."""
    p = c.pff().query("pff_role == 'Pass'")[["gameId", "playId", "nflId"]]
    p = p.merge(c.players()[["nflId", "displayName"]], on="nflId")
    return p.rename(columns={"nflId": "passer_nflId", "displayName": "qb"}).drop_duplicates(["gameId", "playId"])


@lru_cache(maxsize=16)
def game_tracking(game_id):
    """One game of direction-normalized tracking with a `side` column."""
    return c.add_sides(c.read_tracking_file(game_id))


def play_row(r):
    return {"gameId": int(r.gameId), "playId": int(r.playId), "qb": r.qb, "team": r.possessionTeam,
            "opp": r.defensiveTeam, "quarter": int(r.quarter), "down": int(r.down), "togo": int(r.yardsToGo),
            "target": r.displayName_tgt, "sepTarget": round(float(r.sep_tgt), 1),
            "open": r.displayName_open, "sepOpen": round(float(r.sep_open), 1),
            "result": RESULT[r.passResult], "yards": int(r.playResult), "ghost": bool(r.ghost)}


def play_payload(game_id, play_id):
    """Every frame of a play (+ simulated end), as a fresh copy callers may mutate."""
    return copy.deepcopy(_payload(game_id, play_id))


def frame_sep(pos, route_ids, def_ids, los):
    """Space of each route runner (distance to nearest defender) and most open eligible receiver, for one frame."""
    rr = [i for i in route_ids if i in pos]
    dd = [i for i in def_ids if i in pos]
    if not rr or not dd:
        return {}, None
    R = np.array([pos[i][:2] for i in rr])
    D = np.array([pos[i][:2] for i in dd])
    d = np.hypot(R[:, None, 0] - D[None, :, 0], R[:, None, 1] - D[None, :, 1]).min(axis=1)
    elig = [(s, i) for i, s, x in zip(rr, d, R[:, 0]) if x - los >= gt.MIN_DEPTH]
    return {i: round(float(s), 2) for i, s in zip(rr, d)}, (int(max(elig)[1]) if elig else None)


@lru_cache(maxsize=32)
def _payload(game_id, play_id):
    """Every frame of a play: positions [x, y, s, o, dir], space of each route runner, most open at each instant."""
    t = game_tracking(game_id)
    t = t[t.playId == play_id].sort_values(["frameId", "nflId"])
    t[["s", "o", "dir"]] = t[["s", "o", "dir"]].fillna(0)
    fr = c.play_frames(t).iloc[0]
    los = float(fr.los_x)
    play = c.plays().set_index(["gameId", "playId"]).loc[(game_id, play_id)]
    roles = c.pff().query("gameId == @game_id and playId == @play_id").set_index("nflId").pff_role
    names = c.players().set_index("nflId")

    people = t[t.side != "football"].drop_duplicates("nflId")
    players = [{"id": int(r.nflId), "name": names.displayName.get(r.nflId, ""), "jersey": int(r.jerseyNumber),
                "pos": names.officialPosition.get(r.nflId, ""), "side": r.side,
                "route": roles.get(r.nflId) == "Pass Route"} for r in people.itertuples()]
    route_ids = np.array([p["id"] for p in players if p["route"]])
    passer = roles[roles == "Pass"].index

    frames = []
    for fid, f in t.groupby("frameId"):
        ball = f[f.side == "football"]
        pos = {int(r.nflId): [round(float(r.x), 2), round(float(r.y), 2), round(float(r.s), 2),
                              round(float(r.o), 1), round(float(r.dir), 1)]
               for r in f[f.side != "football"].itertuples()}
        rr = f[f.nflId.isin(route_ids)]
        dfn = f[f.side == "defense"]
        sep, most_open = {}, None
        if len(rr) and len(dfn):
            d = np.hypot(rr.x.values[:, None] - dfn.x.values[None, :], rr.y.values[:, None] - dfn.y.values[None, :])
            sep = {int(i): round(float(s), 2) for i, s in zip(rr.nflId, d.min(axis=1))}
            elig = [(s, i) for i, s, x in zip(rr.nflId, d.min(axis=1), rr.x) if x - los >= gt.MIN_DEPTH]
            most_open = int(max(elig)[1]) if elig else None
        frames.append({"frame": int(fid), "event": None if f.event.isna().all() else str(f.event.dropna().iloc[0]),
                       "ball": [round(float(ball.x.iloc[0]), 2), round(float(ball.y.iloc[0]), 2)] if len(ball) else None,
                       "pos": pos, "sep": sep, "mostOpen": most_open})

    pl, _ = data()
    row = pl[(pl.gameId == game_id) & (pl.playId == play_id)]
    info = play_row(row.iloc[0]) if len(row) else {}
    if len(row):
        info.update(targetId=int(row.nflId_tgt.iloc[0]), openId=int(row.nflId_open.iloc[0]))
    payload = {"players": players, "frames": frames, "los": los, "firstDown": los + float(play.yardsToGo),
               "snapFrame": int(fr.snap_frame), "passFrame": None if np.isnan(fr.pass_frame) else int(fr.pass_frame),
               "passerId": int(passer[0]) if len(passer) else None, "description": play.playDescription, "info": info,
               "realEndIdx": len(frames) - 1, "arrivalIdx": None, "catchPoint": None,
               "outcome": outcome(play, players, info)}
    simulate_end(payload)
    return payload


# ---------------------------------------------------------------- fin de l'action simulée
def outcome(play, players, info):
    """Real result of the pass in plain French (from plays.csv)."""
    res = play.passResult
    if res not in OUTCOME_EVENT:
        return None
    interceptor = None
    if res == "C":
        yds = int(play.playResult)
        text = f"Passe réussie à {info.get('target', 'son receveur')} : {'+' if yds >= 0 else ''}{yds} yards"
    elif res == "I":
        text = "Passe ratée : le ballon n'est pas attrapé"
    else:
        interceptor = interceptor_name(play.playDescription, players)
        text = f"Interceptée par {interceptor}" if interceptor else "Passe interceptée par la défense"
    return {"result": res, "text": text, "interceptor": interceptor}


def interceptor_name(desc, players):
    """`INTERCEPTED by T.Diggs` -> full name of the matching defender (or the raw abbreviation)."""
    after = str(desc).split("INTERCEPTED by ", 1)
    if len(after) < 2:
        return None
    norm = c._norm(after[1])
    best = max((p for p in players if p["side"] == "defense" and norm.startswith(c._abbrev(p["name"]))),
               key=lambda p: len(c._abbrev(p["name"])), default=None)
    return best["name"] if best else after[1].split(" ")[0].rstrip(".,")


def simulate_end(d):
    """Real tracking stops ~0.5 s after the throw: extend the play until the ball reaches the target (+0.6 s).

    The ball flies in a straight line to a lead point on the target's current run; players keep running and slow
    down, the target (or the interceptor) arrives at the catch point with the ball, the nearest defender converges.
    """
    frames, info, res = d["frames"], d["info"], (d["outcome"] or {}).get("result")
    pi = next((i for i, f in enumerate(frames) if f["frame"] == d["passFrame"]), None)
    target = info.get("targetId")
    if target is None and res == "IN" and d["outcome"]["interceptor"]:
        # pas de receveur nommé : le ballon va vers l'intercepteur
        target = next((p["id"] for p in d["players"] if p["name"] == d["outcome"]["interceptor"]), None)
    if pi is None or target is None or res is None or target not in frames[pi]["pos"]:
        return
    real_end = len(frames) - 1
    passer_pos = frames[pi]["pos"].get(d["passerId"])
    throw = frames[pi]["ball"] or (passer_pos[:2] if passer_pos else frames[pi]["pos"][target][:2])
    rx, ry, s, _, direction = frames[pi]["pos"][target]
    vx, vy = passing.velocity(s, direction)
    px, py, flight = passing.lead_point(throw[0], throw[1], rx, ry, vx, vy)
    px, py = float(px), float(py)
    arrival = pi + max(1, round(float(flight) * 10))
    end = max(real_end, arrival + SIM_AFTER)

    players = {p["id"]: p for p in d["players"]}
    route_ids = [p["id"] for p in d["players"] if p["route"]]
    def_ids = [p["id"] for p in d["players"] if p["side"] == "defense"]
    cur = {k: list(v) for k, v in frames[real_end]["pos"].items()}
    dist_to_p = lambda i: math.hypot(cur[i][0] - px, cur[i][1] - py)  # noqa: E731
    catcher = target
    if res == "IN":
        name = d["outcome"]["interceptor"]
        catcher = next((i for i in def_ids if i in cur and players[i]["name"] == name), None) \
            or min((i for i in def_ids if i in cur), key=dist_to_p)
    converger = min((i for i in def_ids if i in cur and i != catcher), key=dist_to_p, default=None)
    last_ball = frames[real_end]["ball"] or list(throw)
    bdir = (px - throw[0], py - throw[1])
    bnorm = math.hypot(*bdir) or 1.0

    for k in range(real_end + 1, end + 1):
        new = {}
        for pid, (x, y, sp, _, dr) in cur.items():
            vx, vy = passing.velocity(sp, dr)
            if pid in (target, catcher) and k <= arrival:
                steps = arrival - k + 1
                nx, ny = x + (px - x) / steps, y + (py - y) / steps
            elif pid == converger and k <= arrival + SIM_AFTER:
                ux, uy, n = px - x, py - y, math.hypot(px - x, py - y) or 1.0
                run = max(sp, 6.0)
                nx = x + 0.1 * (0.6 * vx + 0.4 * run * ux / n)
                ny = y + 0.1 * (0.6 * vy + 0.4 * run * uy / n)
            else:
                nx, ny = x + 0.1 * vx * SIM_DECEL, y + 0.1 * vy * SIM_DECEL
            nx, ny = min(max(nx, 0.0), 120.0), min(max(ny, 0.0), 53.3)
            ns = math.hypot(nx - x, ny - y) / 0.1
            nd = math.degrees(math.atan2(nx - x, ny - y)) % 360 if ns > 0.05 else dr
            new[pid] = [round(nx, 2), round(ny, 2), round(ns, 2), round(nd, 1), round(nd, 1)]
        cur = new
        if k <= arrival:
            u = (k - real_end) / (arrival - real_end)
            ball = [last_ball[0] + (px - last_ball[0]) * u, last_ball[1] + (py - last_ball[1]) * u]
        elif res == "I":
            gone = (k - arrival) * 0.1 * 8.0
            ball = [px + bdir[0] / bnorm * gone, py + bdir[1] / bnorm * gone]
        else:
            ball = cur[catcher][:2]
        sep, most_open = frame_sep(cur, route_ids, def_ids, d["los"])
        frames.append({"frame": frames[-1]["frame"] + 1, "event": OUTCOME_EVENT[res] if k == arrival else None,
                       "ball": [round(ball[0], 2), round(ball[1], 2)], "pos": cur, "sep": sep,
                       "mostOpen": most_open, "sim": True})

    # hauteur du ballon : parabole du lancer à l'arrivée, puis tenu (réception / interception) ou au sol (ratée)
    ta = (arrival - pi) / 10
    vz = (BALL_Z1 - BALL_Z0 + GRAVITY * ta ** 2 / 2) / ta
    for i, f in enumerate(frames):
        if i < pi:
            f["ballZ"] = None
        elif i <= arrival:
            tt = (i - pi) / 10
            f["ballZ"] = round(BALL_Z0 + vz * tt - GRAVITY * tt ** 2 / 2, 2)
        else:
            f["ballZ"] = round(max(0.0, BALL_Z1 - BALL_Z1 * (i - arrival) / 4), 2) if res == "I" else 1.2
    d.update(realEndIdx=real_end, arrivalIdx=arrival, catchPoint=[round(px, 2), round(py, 2)])
