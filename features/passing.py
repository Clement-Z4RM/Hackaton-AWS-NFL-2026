"""API « La passe était-elle possible ? » : options du lanceur sur une action + validation du modèle."""
from flask import Blueprint, abort, jsonify, request

import backend as b
import passing

bp = Blueprint("passing", __name__, url_prefix="/api/passing")


@bp.get("/options/<int:game_id>/<int:play_id>")
def options(game_id, play_id):
    try:
        d = b.play_payload(game_id, play_id)
    except (KeyError, IndexError):
        abort(404)
    return jsonify(passing.option_table(
        d,
        ball_speed=request.args.get("ball", passing.BALL_SPEED, type=float),
        def_speed=request.args.get("def", passing.DEF_SPEED, type=float),
        reaction=request.args.get("react", passing.REACTION, type=float)))


@bp.get("/validation")
def validation():
    return jsonify(passing.validation())
