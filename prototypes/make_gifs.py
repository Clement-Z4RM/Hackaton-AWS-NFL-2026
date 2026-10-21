"""Generate animated GIFs of the most telling "forgotten player" plays for the README (outputs/replay_*.gif)."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import backend as b  # noqa: E402
from features.export import render_gif  # noqa: E402

SHOWCASE = [(2021100309, 1520)]   # Stafford -> Jefferson while Higbee is alone (12 yd)
N_EXTRA = 2                       # plus the widest-open forgotten players on failed passes


def pick_plays():
    pl, _ = b.data()
    extra = (pl[pl.ghost & (pl.passResult != "C") & (pl.sep_tgt < 2.5)]
             .sort_values("sep_open", ascending=False))
    keys = list(SHOWCASE)
    for r in extra.itertuples():
        if len(keys) >= len(SHOWCASE) + N_EXTRA:
            break
        if (r.gameId, r.playId) not in keys:
            keys.append((int(r.gameId), int(r.playId)))
    return keys


if __name__ == "__main__":
    out = ROOT / "outputs"
    out.mkdir(exist_ok=True)
    for g, p in pick_plays():
        path = out / f"replay_{g}_{p}.gif"
        path.write_bytes(render_gif(g, p))
        print(f"{path}  ({path.stat().st_size / 1e6:.2f} Mo)")
