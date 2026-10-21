"""Ghost Targets: who was the most open receiver at the throw, and was he the one targeted?

"Most open" = largest distance to the nearest defender at the moment of the throw, among
route runners at least MIN_DEPTH yards past the line of scrimmage (otherwise backs waiting
behind the line are trivially "open" because nobody covers them there).
A "ghost" is a play where the most open receiver was wide open (>= WIDE_OPEN yards) and was
not targeted while the targeted receiver was at least MARGIN yards tighter.
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Patch
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common as c  # noqa: E402

MIN_DEPTH = 2.0     # yards past the line of scrimmage to count as a real option
WIDE_OPEN = 5.0     # NGS-style "wide open" separation threshold (yards)
MARGIN = 2.0        # target must be this much tighter than the most open receiver
MIN_ROUTES = 100    # minimum routes for the player ranking
POS_COLORS = {"WR": "#1f77b4", "TE": "#ff7f0e", "RB": "#2ca02c", "FB": "#2ca02c"}


def build_plays(rec):
    """One row per pass attempt: targeted receiver vs most open eligible receiver."""
    att = rec[rec.passResult.isin(["C", "I", "IN"]) & rec.target_nflId.notna()]
    tgt = att[att.targeted][["gameId", "playId", "nflId", "displayName", "sep", "depth"]]
    elig = att[att.depth >= MIN_DEPTH]
    best = elig.loc[elig.groupby(["gameId", "playId"]).sep.idxmax(),
                    ["gameId", "playId", "nflId", "displayName", "officialPosition", "sep", "depth"]]
    pl = (tgt.merge(best, on=["gameId", "playId"], suffixes=("_tgt", "_open"))
          .merge(att[["gameId", "playId", "passResult", "playResult", "down", "yardsToGo"]]
                 .drop_duplicates(["gameId", "playId"]), on=["gameId", "playId"]))
    pl["hit_most_open"] = pl.nflId_tgt == pl.nflId_open
    pl["ghost"] = (~pl.hit_most_open) & (pl.sep_open >= WIDE_OPEN) & (pl.sep_tgt <= pl.sep_open - MARGIN)
    pl["complete"] = pl.passResult == "C"
    return pl


def player_ranking(rec, pl):
    routes = (rec[rec.depth >= MIN_DEPTH].groupby(["nflId", "displayName", "officialPosition", "team"])
              .size().rename("routes").reset_index())
    ghosts = pl[pl.ghost].groupby("nflId_open").size().rename("ghosts")
    tgts = rec[rec.targeted].groupby("nflId").size().rename("targets")
    rk = routes.merge(ghosts, left_on="nflId", right_index=True, how="left") \
               .merge(tgts, left_on="nflId", right_index=True, how="left").fillna({"ghosts": 0, "targets": 0})
    rk["ghost_rate"] = rk.ghosts / rk.routes
    rk["target_rate"] = rk.targets / rk.routes
    # backs run far fewer routes past the line, so they get a lower bar
    min_routes = rk.officialPosition.map({"RB": MIN_ROUTES // 3, "FB": MIN_ROUTES // 3}).fillna(MIN_ROUTES)
    return rk[rk.routes >= min_routes].sort_values("ghosts", ascending=False)


def plot_ranking(rk, path):
    top = rk.head(15).iloc[::-1]
    fig, ax = plt.subplots(figsize=(9, 6.5))
    bars = ax.barh(top.displayName + " (" + top.team.astype(str) + ")", top.ghosts,
                   color=top.officialPosition.map(POS_COLORS).fillna("grey"))
    for b, (_, r) in zip(bars, top.iterrows()):
        ax.text(b.get_width() + 0.3, b.get_y() + b.get_height() / 2,
                f"{r.ghost_rate:.1%} of routes · {int(r.targets)} targets", va="center", fontsize=8)
    ax.set_xlabel(f"Plays wide open (≥{WIDE_OPEN:.0f} yd) but ignored by the QB")
    ax.set_title("Ghost Targets — the receivers QBs leave open\n2021 weeks 1-8, at the moment of the throw",
                 loc="left", fontsize=12)
    ax.spines[["top", "right"]].set_visible(False)
    ax.set_xlim(0, top.ghosts.max() * 1.45)
    ax.legend(handles=[Patch(color=POS_COLORS[p], label=p) for p in ["WR", "TE", "RB"]],
              loc="lower right", frameon=False)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_example(pl, path):
    ex = pl[pl.ghost & (pl.passResult != "C")].sort_values("sep_open", ascending=False)
    ex = ex[ex.sep_tgt < 1.5].iloc[0]
    fig = draw_play(ex)
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return ex


def draw_play(ex):
    """Field view at the throw for one row of build_plays(): circles = space to the nearest defender."""
    snap = c.pass_snapshot()
    g, p = ex.gameId, ex.playId
    s = snap[(snap.gameId == g) & (snap.playId == p)]
    play = c.plays().set_index(["gameId", "playId"]).loc[(g, p)]
    los = s.los_x.iloc[0]
    passer = c.pff().query("gameId == @g and playId == @p and pff_role == 'Pass'").nflId.iloc[0]
    qb = c.players().set_index("nflId").displayName[passer]
    routes = set(c.pff().query("gameId == @g and playId == @p and pff_role == 'Pass Route'").nflId)
    rec = c.receivers_at_throw().query("gameId == @g and playId == @p").set_index("nflId")

    fig, ax = plt.subplots(figsize=(9, 9))
    c.draw_field(ax, los - 12, los + 38)
    ax.axvline(los, color="#64b5f6", lw=2, label="Ligne de départ de l'action")
    ax.axvline(los + play.yardsToGo, color="#ffeb3b", lw=2, label="Distance à atteindre")
    off, dfn, ball = s[s.side == "offense"], s[s.side == "defense"], s[s.side == "football"]
    ax.scatter(dfn.x, dfn.y, c="#e53935", s=70, edgecolors="white", zorder=3, label="Défense")
    ax.scatter(off.x, off.y, c="#1e3a8a", s=70, edgecolors="white", zorder=3, label="Attaque")
    ax.scatter(ball.x, ball.y, c="#8d6e63", s=40, marker="D", zorder=4)
    for nid, r in rec.iterrows():
        if nid not in routes:
            continue
        is_t, is_o = nid == ex.nflId_tgt, nid == ex.nflId_open
        col = "#ff9800" if is_t else "#ffeb3b" if is_o else "white"
        ax.add_patch(Circle((r.x, r.y), r.sep, fill=False, color=col, lw=2.5 if (is_t or is_o) else 1,
                            ls="-" if (is_t or is_o) else ":", zorder=2))
        if is_t or is_o:
            tag = "VISÉ" if is_t else "LE PLUS LIBRE"
            ax.annotate(f"{tag} : {r.displayName}\n{r.sep:.1f} yd d'espace", (r.x, r.y),
                        xytext=(8, 8), textcoords="offset points", color=col, fontsize=9, weight="bold")
    outcome = {"I": "passe ratée", "IN": "INTERCEPTÉE", "C": "passe réussie"}[ex.passResult]
    ax.set_title(f"{qb} lance vers {ex.displayName_tgt} ({ex.sep_tgt:.1f} yd d'espace) → {outcome}\n"
                 f"alors que {ex.displayName_open} est seul avec {ex.sep_open:.1f} yd d'espace   "
                 f"[{play.possessionTeam} contre {play.defensiveTeam}, {play.quarter}e quart-temps, "
                 f"tentative {play.down}, {play.yardsToGo} yd à faire]",
                 loc="left", fontsize=10)
    ax.legend(loc="lower left", fontsize=8, framealpha=0.85)
    fig.text(0.01, 0.005, "Cercles = distance au défenseur le plus proche au moment du lancer.",
             fontsize=8, color="grey")
    fig.tight_layout(rect=(0, 0.02, 1, 1))
    return fig


def main():
    c.OUT.mkdir(exist_ok=True)
    rec = c.receivers_at_throw()
    pl = build_plays(rec)

    print(f"Pass attempts analysed: {len(pl)}")
    print(f"Target was NOT the most open eligible receiver: {1 - pl.hit_most_open.mean():.1%}")
    print(f"Ghost plays (open man ≥{WIDE_OPEN:.0f} yd ignored, target ≥{MARGIN:.0f} yd tighter): "
          f"{pl.ghost.mean():.1%} ({pl.ghost.sum()})")
    summary = pl.groupby("hit_most_open").agg(plays=("complete", "size"), completion=("complete", "mean"),
                                              yards=("playResult", "mean"), target_sep=("sep_tgt", "mean"))
    summary.index = summary.index.map({True: "targeted most open", False: "targeted someone else"})
    print(summary.round(3).to_string())
    print("Ghost plays: completion", f"{pl[pl.ghost].complete.mean():.1%}", "vs others",
          f"{pl[~pl.ghost].complete.mean():.1%}")
    print("Ghosted receiver position:", pl[pl.ghost].officialPosition.value_counts(normalize=True).round(2).to_dict())

    rk = player_ranking(rec, pl)
    cols = ["displayName", "team", "officialPosition", "routes", "targets", "ghosts", "ghost_rate"]
    print("\nTop ghosts (volume):\n", rk[cols].head(15).to_string(index=False))
    for pos in ["WR", "TE", "RB"]:
        print(f"\nTop {pos} by ghost rate:\n",
              rk[rk.officialPosition == pos].sort_values("ghost_rate", ascending=False)[cols].head(5)
              .to_string(index=False))
    rk.to_csv(c.OUT / "ghost_targets_ranking.csv", index=False)

    plot_ranking(rk, c.OUT / "ghost_targets_ranking.png")
    ex = plot_example(pl, c.OUT / "ghost_targets_example.png")
    print(f"\nExample play: game {ex.gameId} play {ex.playId}")


if __name__ == "__main__":
    main()
