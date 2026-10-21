"""Extension « Partager l'action » : rend une action complète en GIF animé (matplotlib + Pillow).

GET /api/export/<gameId>/<playId>.gif  (cache disque dans data/cache/export/)
"""
import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from flask import Blueprint, abort, send_file  # noqa: E402
from matplotlib.patches import Circle, Ellipse  # noqa: E402
from PIL import Image  # noqa: E402

import backend as b  # noqa: E402
from backend import c  # noqa: E402

bp = Blueprint("export", __name__, url_prefix="/api/export")
CACHE = c.CACHE / "export"

OFF, DEF, OPEN, TARGET, BALL = "#3b82f6", "#ef4444", "#facc15", "#fb923c", "#a16207"
FRAME_MS = 200      # 10 images/s jouées au ralenti ×0,5
THROW_MS = 1500     # pause sur l'image du lancer
END_MS = 2000       # pause sur la dernière image
VIEW_W = 55
RESULT_TXT = {"réussie": "passe réussie", "ratée": "passe ratée", "interceptée": "passe INTERCEPTÉE"}


def _last(name):
    return name.split(" ", 1)[1] if " " in name else name


def _num(x):
    return f"{x:.1f}".replace(".", ",")


def _title(d):
    i = d["info"]
    if not i:
        return d["description"][:90]
    res = RESULT_TXT.get(i["result"], i["result"])
    line1 = f"{i['qb']} lance vers {i['target']} ({_num(i['sepTarget'])} yd d'espace) → {res}"
    line2 = (f"{i['open']} était le plus libre avec {_num(i['sepOpen'])} yd d'espace"
             if i["openId"] != i["targetId"] else "C'était bien le joueur le plus libre")
    return f"{line1}\n{line2}   [{i['team']} contre {i['opp']}, {i['quarter']}e quart-temps]"


def _draw_frame(ax, d, i, snap_idx, pass_idx):
    """One frame, same visual language as the website."""
    ax.clear()
    los = d["los"]
    x0 = los - 12
    c.draw_field(ax, x0, x0 + VIEW_W)
    for x in range(20, 110, 10):
        if x0 < x < x0 + VIEW_W:
            yard = x - 10
            for y in (10, 42):
                ax.text(x, y, str(min(yard, 100 - yard)), color="white", alpha=0.5, fontsize=16,
                        weight="bold", ha="center", va="center")
    ax.axvline(los, color="#60a5fa", lw=2.5)
    ax.axvline(d["firstDown"], color="#fde047", lw=2.5)

    frames, info = d["frames"], d["info"]
    f = frames[i]
    reveal = i >= pass_idx and bool(info)
    tgt, opn = info.get("targetId"), info.get("openId")
    routes = [p for p in d["players"] if p["route"]]

    # traces des receveurs depuis le début de l'action
    if i > snap_idx:
        for p in routes:
            pts = [frames[j]["pos"][p["id"]][:2] for j in range(snap_idx, i + 1) if p["id"] in frames[j]["pos"]]
            if len(pts) < 2:
                continue
            xs, ys = zip(*pts)
            is_t, is_o = reveal and p["id"] == tgt, reveal and p["id"] == opn
            ax.plot(xs, ys, color=TARGET if is_t else OPEN if is_o else "white",
                    alpha=1 if (is_t or is_o) else 0.35, lw=2.2 if (is_t or is_o) else 1.2, zorder=2)

    # cercles d'espace
    if i >= snap_idx:
        for p in routes:
            q, s = f["pos"].get(p["id"]), f["sep"].get(p["id"])
            if q is None or s is None:
                continue
            open_now, is_t = p["id"] == f["mostOpen"], reveal and p["id"] == tgt
            if open_now:
                ax.add_patch(Circle(q[:2], s, color=OPEN, alpha=0.15, lw=0, zorder=2))
            ax.add_patch(Circle(q[:2], s, fill=False, zorder=3,
                                color=TARGET if is_t else OPEN if open_now else "white",
                                lw=2.5 if (open_now or is_t) else 0.9, ls="-" if (open_now or is_t) else ":"))

    # joueurs
    for p in d["players"]:
        q = f["pos"].get(p["id"])
        if q is None:
            continue
        ax.add_patch(Circle(q[:2], 0.85, facecolor=OFF if p["side"] == "offense" else DEF,
                            edgecolor="white", lw=1.2, zorder=4))
        ax.text(q[0], q[1], str(p["jersey"]), color="white", fontsize=6.5, weight="bold",
                ha="center", va="center", zorder=5, clip_on=True)
    if f["ball"]:
        ax.add_patch(Ellipse(f["ball"], 1.2, 0.8, facecolor=BALL, edgecolor="white", lw=0.8, zorder=6))

    # noms + étiquettes au lancer
    box = dict(boxstyle="round,pad=0.25", fc="#0f172a", ec="none", alpha=0.75)
    for p in routes:
        q = f["pos"].get(p["id"])
        if q is None:
            continue
        is_t, is_o = reveal and p["id"] == tgt, reveal and p["id"] == opn and opn != tgt
        s = f["sep"].get(p["id"], 0)
        label = (f"VISÉ : {p['name']} ({_num(s)} yd)" if is_t
                 else f"LE PLUS LIBRE : {p['name']} ({_num(s)} yd)" if is_o else _last(p["name"]))
        strong = is_t or is_o
        lx = min(max(q[0], x0 + 9), x0 + VIEW_W - 9) if strong else q[0]
        below = q[1] > 49  # près du bord haut : étiquette sous le joueur pour rester dans le terrain
        ax.text(lx, q[1] - 1.6 if below else q[1] + 1.6, label, color=TARGET if is_t else OPEN if is_o else "white",
                fontsize=8.5 if strong else 6.5, weight="bold" if strong else "normal",
                ha="center", va="top" if below else "bottom", bbox=box, zorder=7, clip_on=not strong)

    # bandeau d'état + chrono
    secs = (i - snap_idx) / 10
    status = ("Avant le début de l'action" if i < snap_idx
              else "Le ballon est lancé !" if i >= pass_idx else "L'action est en cours")
    clock = f"{_num(-secs)} s avant le début" if secs < 0 else f"{_num(secs)} s après le début"
    ax.text(x0 + 0.8, 52.3, f"{status}   ·   {clock}", color=OPEN if i >= pass_idx else "white",
            fontsize=9, weight="bold", va="top", bbox=box, zorder=8)


def render_gif(game_id, play_id):
    """GIF bytes for one play (cached on disk)."""
    path = CACHE / f"{game_id}_{play_id}.gif"
    if path.exists():
        return path.read_bytes()
    d = b.play_payload(game_id, play_id)
    frames = d["frames"]
    n = len(frames)
    snap_idx = next((k for k, f in enumerate(frames) if f["frame"] == d["snapFrame"]), 0)
    pass_idx = next((k for k, f in enumerate(frames) if f["frame"] == d["passFrame"]), n - 1)

    fig = plt.figure(figsize=(7, 7.6), dpi=100, facecolor="#0f172a")
    ax = fig.add_axes((0.02, 0.06, 0.96, 0.82))
    fig.text(0.02, 0.985, _title(d), color="#e2e8f0", fontsize=9.5, va="top", linespacing=1.5)
    fig.text(0.02, 0.02, "Cercles = distance au défenseur le plus proche · jaune = le plus libre · "
             "orange = le joueur visé · Données NFL Big Data Bowl", color="#94a3b8", fontsize=7)

    images, durations = [], []
    for k in range(n):
        _draw_frame(ax, d, k, snap_idx, pass_idx)
        fig.canvas.draw()
        rgb = Image.fromarray(np.asarray(fig.canvas.buffer_rgba())[..., :3])
        images.append(rgb)
        durations.append(THROW_MS if k == pass_idx else END_MS if k == n - 1 else FRAME_MS)
    plt.close(fig)

    # une palette commune (construite sur l'image du lancer) limite le poids et le scintillement
    palette = images[pass_idx].quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    frames_p = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
    buf = io.BytesIO()
    frames_p[0].save(buf, format="GIF", save_all=True, append_images=frames_p[1:], duration=durations,
                     loop=0, optimize=True, disposal=1)
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())
    return buf.getvalue()


@bp.get("/<int:game_id>/<int:play_id>.gif")
def export_gif(game_id, play_id):
    try:
        data = render_gif(game_id, play_id)
    except (KeyError, IndexError, FileNotFoundError):
        abort(404)
    return send_file(io.BytesIO(data), mimetype="image/gif",
                     download_name=f"action_{game_id}_{play_id}.gif", max_age=3600)
