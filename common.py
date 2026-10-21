"""Shared data loading for the NFL Big Data Bowl prototypes.

All tracking coordinates are normalized so the offense always moves left -> right
(x increasing). `los_x` is the line of scrimmage (ball x at the snap).
"""
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from pathlib import Path
import re

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
OUT = ROOT / "outputs"

SNAP_EVENTS = ["ball_snap", "autoevent_ballsnap"]
PASS_EVENTS = ["pass_forward", "autoevent_passforward"]
SKILL_POSITIONS = ["WR", "TE", "RB", "FB"]

TRACK_DTYPES = {
    "gameId": "int64", "playId": "int32", "nflId": "float64", "frameId": "int16",
    "jerseyNumber": "float32", "team": "category", "playDirection": "category",
    "x": "float32", "y": "float32", "s": "float32", "a": "float32", "dis": "float32",
    "o": "float32", "dir": "float32", "event": "category",
}


# ---------------------------------------------------------------- metadata
@lru_cache
def games():
    return pd.read_csv(DATA / "games.csv")


@lru_cache
def plays():
    return pd.read_csv(DATA / "plays.csv")


@lru_cache
def players():
    return pd.read_csv(DATA / "players.csv")


@lru_cache
def pff():
    return pd.read_csv(DATA / "pffScoutingData.csv")


def game_ids():
    return games().gameId.tolist()


# ---------------------------------------------------------------- tracking
def read_tracking_file(game_id):
    """One game of tracking, direction-normalized."""
    t = pd.read_csv(DATA / "tracking" / f"tracking_{game_id}.csv",
                    dtype=TRACK_DTYPES, usecols=list(TRACK_DTYPES), na_values=["NA"])
    t["event"] = t["event"].cat.remove_categories(["None"]) if "None" in t["event"].cat.categories else t["event"]
    left = t["playDirection"] == "left"
    t.loc[left, "x"] = 120 - t.loc[left, "x"]
    t.loc[left, "y"] = 53.3 - t.loc[left, "y"]
    t.loc[left, "o"] = (t.loc[left, "o"] + 180) % 360
    t.loc[left, "dir"] = (t.loc[left, "dir"] + 180) % 360
    return t


def load_tracking(game_list=None, workers=8):
    """Concatenate tracking for `game_list` (default: all 122 games)."""
    game_list = game_ids() if game_list is None else list(game_list)
    with ProcessPoolExecutor(workers) as ex:
        parts = list(ex.map(read_tracking_file, game_list))
    t = pd.concat(parts, ignore_index=True)
    for c in ["team", "playDirection", "event"]:
        t[c] = t[c].astype("category")
    return t


def play_frames(track):
    """Per play: snap frame, pass frame, line of scrimmage x."""
    ev = track.dropna(subset=["event"])
    snap = ev[ev.event.isin(SNAP_EVENTS)].groupby(["gameId", "playId"]).frameId.min().rename("snap_frame")
    pas = ev[ev.event.isin(PASS_EVENTS)].groupby(["gameId", "playId"]).frameId.min().rename("pass_frame")
    frames = pd.concat([snap, pas], axis=1).reset_index()

    ball = track[track.team == "football"][["gameId", "playId", "frameId", "x"]]
    los = frames.merge(ball, left_on=["gameId", "playId", "snap_frame"],
                       right_on=["gameId", "playId", "frameId"], how="left")
    frames["los_x"] = los["x"].values
    return frames


def add_sides(df):
    """Add `side` (offense/defense/football) using plays.possessionTeam."""
    pos = plays()[["gameId", "playId", "possessionTeam"]]
    df = df.merge(pos, on=["gameId", "playId"], how="left")
    df["side"] = np.where(df.team == "football", "football",
                          np.where(df.team.astype(str) == df.possessionTeam, "offense", "defense"))
    return df.drop(columns="possessionTeam")


def snapshot(track, frames, frame_col="pass_frame"):
    """All players (and ball) at a given per-play frame, with sides and depth past the LOS."""
    keys = frames[["gameId", "playId", frame_col, "los_x"]].dropna().astype({frame_col: "int16"})
    snap = track.merge(keys,
                       left_on=["gameId", "playId", "frameId"],
                       right_on=["gameId", "playId", frame_col])
    snap = add_sides(snap)
    snap["depth"] = snap.x - snap.los_x
    return snap.drop(columns=[frame_col])


def nearest_defender(snap):
    """For every offensive player in a snapshot: distance + nflId of the closest defender."""
    out = []
    for (g, p), grp in snap.groupby(["gameId", "playId"], sort=False):
        off = grp[grp.side == "offense"]
        dfn = grp[grp.side == "defense"]
        if off.empty or dfn.empty:
            continue
        d = np.hypot(off.x.values[:, None] - dfn.x.values[None, :],
                     off.y.values[:, None] - dfn.y.values[None, :])
        j = d.argmin(axis=1)
        out.append(pd.DataFrame({"gameId": g, "playId": p, "nflId": off.nflId.values,
                                 "sep": d.min(axis=1), "nearest_def": dfn.nflId.values[j]}))
    return pd.concat(out, ignore_index=True)


# ---------------------------------------------------------------- targets
def _norm(s):
    return re.sub(r"[^a-z]", "", str(s).lower())


def _abbrev(display_name):
    first, _, last = str(display_name).partition(" ")
    return _norm(first[:1] + last)


_TARGET_RE = re.compile(r"pass (?:incomplete )?(?:short|deep)(?: (?:left|middle|right))? (?:to|intended for) (.*)")


@lru_cache
def targets():
    """Targeted receiver per play, parsed from playDescription and matched to offensive players."""
    pl = plays()[["gameId", "playId", "playDescription"]].copy()
    pl["after"] = pl.playDescription.str.extract(_TARGET_RE, expand=False).map(_norm, na_action="ignore")
    cand = pff()[pff().pff_role.isin(["Pass Route", "Pass Block"])][["gameId", "playId", "nflId"]]
    cand = cand.merge(players()[["nflId", "displayName"]], on="nflId")
    cand["abbr"] = cand.displayName.map(_abbrev)
    cand = cand.merge(pl[["gameId", "playId", "after"]].dropna(), on=["gameId", "playId"])
    cand = cand[[a.startswith(b) for a, b in zip(cand.after, cand.abbr)]]
    cand = cand.assign(n=cand.abbr.str.len()).sort_values("n").drop_duplicates(["gameId", "playId"], keep="last")
    return cand[["gameId", "playId", "nflId"]].rename(columns={"nflId": "target_nflId"}).reset_index(drop=True)


# ---------------------------------------------------------------- cache
def pass_snapshot():
    """Snapshot of all 22 players + ball at the moment of the throw, for all games (cached)."""
    path = CACHE / "pass_snapshot.pkl"
    if path.exists():
        return pd.read_pickle(path)
    CACHE.mkdir(parents=True, exist_ok=True)
    parts = []
    for chunk in np.array_split(game_ids(), 8):
        t = load_tracking(chunk)
        parts.append(snapshot(t, play_frames(t)))
    snap = pd.concat(parts, ignore_index=True)
    snap.to_pickle(path)
    return snap


def receivers_at_throw():
    """One row per route runner at the throw: depth, separation, position, targeted flag (cached)."""
    path = CACHE / "receivers_at_throw.pkl"
    if path.exists():
        return pd.read_pickle(path)
    snap = pass_snapshot()
    sep = nearest_defender(snap)
    routes = pff()[pff().pff_role == "Pass Route"][["gameId", "playId", "nflId", "pff_positionLinedUp"]]
    rec = (snap[snap.side == "offense"][["gameId", "playId", "nflId", "team", "x", "y", "s", "dir", "depth", "los_x"]]
           .merge(routes, on=["gameId", "playId", "nflId"])
           .merge(sep, on=["gameId", "playId", "nflId"])
           .merge(players()[["nflId", "displayName", "officialPosition"]], on="nflId")
           .merge(targets(), on=["gameId", "playId"], how="left"))
    rec["targeted"] = rec.nflId == rec.target_nflId
    rec = rec.merge(plays()[["gameId", "playId", "down", "yardsToGo", "passResult", "playResult",
                             "pff_passCoverage", "pff_passCoverageType", "offenseFormation"]],
                    on=["gameId", "playId"])
    rec.to_pickle(path)
    return rec


# ---------------------------------------------------------------- plotting
def draw_field(ax, x_min=0, x_max=120):
    """Simple green field with yard lines (normalized coords)."""
    ax.set_facecolor("#2e7d32")
    for x in range(10, 111, 5):
        ax.axvline(x, color="white", lw=0.8 if x % 10 == 0 else 0.3, alpha=0.6)
    ax.axvspan(0, 10, color="#1b5e20")
    ax.axvspan(110, 120, color="#1b5e20")
    ax.set_xlim(x_min, x_max)
    ax.set_ylim(0, 53.3)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    return ax


if __name__ == "__main__":
    import time
    t0 = time.time()
    rec = receivers_at_throw()
    print(f"{len(rec)} route-runner rows at throw, {rec[['gameId','playId']].drop_duplicates().shape[0]} plays "
          f"({time.time()-t0:.0f}s)")
    print("target match rate:", targets().shape[0], "/", plays().shape[0])
    print(rec.groupby("officialPosition").sep.describe().round(2))
