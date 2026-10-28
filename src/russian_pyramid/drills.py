"""Built-in practice drills.

Each drill is a plain layout ``{ball_id: (x, y)}`` plus metadata.  Positions
were chosen so that a dead-center aim pots (see tests/test_drills.py); the
corner drills aim along the pocket bisector, which is the only reliable way
into a 74 mm pyramid mouth.
"""

from __future__ import annotations

import math

import numpy as np

from russian_pyramid import config
from russian_pyramid.physics import ghost_aim

W = config.TABLE_KWARGS["w"]
L = config.TABLE_KWARGS["l"]
R = config.BALL_R

FOOT_SPOT = (W / 2, 0.75 * L)   # apex of the rack
HEAD_SPOT = (W / 2, 0.25 * L)   # cue ball home


def _u(toward: tuple[float, float]) -> np.ndarray:
    v = np.asarray(toward, dtype=float) / np.linalg.norm(toward)
    return v


def _corner_unit(pocket_id: str) -> np.ndarray:
    """Unit vector along the corner bisector, from the corner into the table.

    Note: the true bisector (45 degrees), NOT the line to the table center --
    on a 2:1 table those differ by ~18 degrees.
    """
    bisectors = {
        "lb": (1.0, 1.0), "lt": (1.0, -1.0), "rb": (-1.0, 1.0), "rt": (-1.0, -1.0),
    }
    return _u(bisectors[pocket_id])


def _corner_drill(pocket_id: str, obj_dist: float, cue_dist: float = 0.60,
                  cut_deg: float = 0.0) -> dict:
    """Object ball on a corner bisector; cue behind the ghost ball.

    For cut_deg > 0 the cue ball is offset so the shot is a true cut while the
    object ball still departs along the bisector.
    """
    corner_pt = {"lb": (0, 0), "lt": (0, L), "rb": (W, 0), "rt": (W, L)}[pocket_id]
    into = _corner_unit(pocket_id)                   # corner -> table interior
    obj = np.asarray(corner_pt, dtype=float) + into * obj_dist
    dep = -into                                      # object ball departure direction
    ghost = obj - dep * 2 * R                        # on the far side from the pocket

    if cut_deg == 0.0:
        cue = ghost - dep * cue_dist
    else:
        ang = math.radians(cut_deg)
        rot = np.array([[math.cos(ang), -math.sin(ang)],
                        [math.sin(ang), math.cos(ang)]])
        d = rot @ dep
        cue = ghost - d * cue_dist
        if not (R < cue[0] < W - R and R < cue[1] < L - R):
            cue = ghost - (rot.T @ dep) * cue_dist

    positions = {"cue": (float(cue[0]), float(cue[1])),
                 "1": (float(obj[0]), float(obj[1]))}
    return {"balls": positions, "aim_hint": ghost_aim(positions, "1", corner_pt)}


def _side_drill(pocket_id: str, obj_xy: tuple[float, float], cut_deg: float = 0.0,
                cue_dist: float = 0.75) -> dict:
    """Side-pocket drill; object ball placed on the line into the pocket mouth."""
    center = {"lc": (0.0, L / 2), "rc": (W, L / 2)}[pocket_id]
    entry = (min(max(center[0], R), W - R), L / 2)
    obj = np.asarray(obj_xy, dtype=float)
    u = _u(entry - obj)
    ghost = obj - u * 2 * R
    if cut_deg == 0.0:
        cue = ghost - u * cue_dist
    else:
        ang = math.radians(cut_deg)
        rot = np.array([[math.cos(ang), -math.sin(ang)],
                        [math.sin(ang), math.cos(ang)]])
        d = rot @ u
        cand = ghost - d * cue_dist
        if not (R < cand[0] < W - R and R < cand[1] < L - R):
            d = rot.T @ u
            cand = ghost - d * cue_dist
        cue = cand
    positions = {"cue": (float(cue[0]), float(cue[1])),
                 "1": (float(obj[0]), float(obj[1]))}
    return {"balls": positions, "aim_hint": ghost_aim(positions, "1", entry)}


def _rack(shuffle: bool = False) -> dict:
    """Full 15-ball pyramid rack with the apex on the foot spot."""
    gap = 2 * R + 0.0006
    balls: dict[str, tuple[float, float]] = {"cue": HEAD_SPOT}
    numbers = list(range(1, 16))
    if shuffle:
        rng = np.random.default_rng()
        rng.shuffle(numbers)
    k = 0
    for row in range(5):
        for i in range(row + 1):
            x = FOOT_SPOT[0] + (i - row / 2) * gap
            y = FOOT_SPOT[1] + row * gap * math.sin(math.pi / 3)
            balls[str(numbers[k])] = (x, y)
            k += 1
    return balls


DRILLS: dict[str, dict] = {
    "free": {
        "label": "Free practice",
        "description": "Empty table. Place balls wherever you like and repeat.",
        "build": lambda: {"balls": {"cue": HEAD_SPOT}, "aim_hint": 90.0},
    },
    "rack": {
        "label": "Full rack (break)",
        "description": "15-ball pyramid on the foot spot. Break it, then keep potting.",
        "build": lambda: {"balls": _rack(), "aim_hint": 90.0},
    },
    "straight_corner": {
        "label": "Straight ball, corner",
        "description": "Dead straight into the top-right corner along the bisector. "
                       "The pocket allows less than 0.1 degrees of error.",
        "build": lambda: _corner_drill("rt", 0.75),
    },
    "cut_corner_30": {
        "label": "30° cut, corner",
        "description": "Object ball 1.6 m from the top-right corner, 30° cut.",
        "build": lambda: _corner_drill("rt", 1.60, cut_deg=30.0),
    },
    "cut_corner_45": {
        "label": "45° cut, corner",
        "description": "Object ball 1.9 m from the top-right corner, 45° cut.",
        "build": lambda: _corner_drill("rt", 1.90, cut_deg=45.0),
    },
    "side_straight": {
        "label": "Straight ball, side",
        "description": "Straight into the right side pocket. Watch the jaws.",
        "build": lambda: _side_drill("rc", (1.10, L / 2)),
    },
    "side_cut_30": {
        "label": "30° cut, side",
        "description": "Cut into the right side pocket.",
        "build": lambda: _side_drill("rc", (1.15, L / 2 + 0.45), cut_deg=30.0),
    },
    "svoyak": {
        "label": "Svoyak (cue-ball carom)",
        "description": "Pot the object ball, then use the cue-ball scratch to learn "
                       "carom control. Thin cut into the top-right corner.",
        "build": lambda: _corner_drill("rt", 0.85, cue_dist=0.70, cut_deg=35.0),
    },
}


def names() -> list[str]:
    return list(DRILLS)


def catalog() -> list[dict]:
    return [
        {"id": key, "label": d["label"], "description": d["description"]}
        for key, d in DRILLS.items()
    ]


def build(drill: str) -> dict:
    try:
        return DRILLS[drill]["build"]()
    except KeyError:
        raise ValueError(f"unknown drill {drill!r}") from None
