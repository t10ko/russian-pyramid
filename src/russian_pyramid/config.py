"""Russian Pyramid table, ball, and cushion physics configuration.

Everything here was validated empirically against pooltool 0.6:

* Pooltool pots a ball the instant its center enters a capture circle
  (``*_pocket_radius`` around a point ``*_pocket_depth`` beyond the corner /
  rail).  That circle's near edge is the *fall line*: where the slate ends
  and the ball tips into the pocket.  It is placed from the ICP/FBSR table
  regulation rather than tuned by hand:

  - corner pockets: 72-73 mm mouth, R1 = 5 mm rounded rubber noses, and a
    parallel "corridor" (коридор) of only 5-6 mm before the jaws open up into
    the pocket.  The fall line therefore sits at the end of that short
    corridor (see :func:`_corner_fall_depth`).  An earlier version captured
    balls ~25 mm deep inside a 75 mm-long parallel tunnel, which made corner
    pots noticeably harder than on a real table.
  - side pockets: 82-83 mm mouth, R2 = 11 mm noses, corridor 0 mm.  The fall
    line sits ~5 mm in front of the cushion-nose line (cloth bevel / скат);
    previously it sat 20 mm out on the cloth, which made sides too generous.

  The capture radius MUST exceed the depth or the pocket is un-pottable.
* The mouth is measured between the parallel jaw faces: 72.5 mm for a 68 mm
  ball leaves ~2.25 mm of slack per side on a dead-center entry.
* e_c / f_c apply to ALL cushions in pooltool (rails and jaws alike), not
  only to the jaws.  Two presets are provided: ``tournament`` for lively
  pyramid rails, and ``research`` for the heavily deadened leather-jaw values.
"""

from __future__ import annotations

import numpy as np
import pooltool as pt
from pooltool.objects.cue.datatypes import CueSpecs
from pooltool.objects.table.specs import PocketTableSpecs

# --- 12-foot Russian Pyramid table (playing surface 3.56 m x 1.78 m) --------
# Note: in pooltool's layout.py, the jaw horn circle centers are separated by
# `pocket_width + 2 * jaw_radius`, so the actual physical gap between the two
# rounded jaw surfaces is `pocket_width` (72.5 mm corners, 82.0 mm sides for a
# 68.0 mm ball — official ICP / FBSR Russian Pyramid tournament spec).
CORNER_POCKET_WIDTH = 0.0725
CORNER_JAW_RADIUS = 0.005       # R1 = 5 mm rubber nose rounding (regulation)
CORNER_CORRIDOR = 0.0055        # 5-6 mm parallel corridor before the pocket opens
CORNER_CAPTURE_RADIUS = 0.060


def _corner_fall_depth(width: float = CORNER_POCKET_WIDTH,
                       jaw_radius: float = CORNER_JAW_RADIUS,
                       corridor: float = CORNER_CORRIDOR,
                       capture_radius: float = CORNER_CAPTURE_RADIUS) -> float:
    """``corner_pocket_depth`` that puts the fall line at the corridor's end.

    With straight jaws (``corner_pocket_angle = 0``) the jaw faces run parallel
    to the corner bisector.  The rounded nose meets the jaw face at
    ``u0 = (w/sqrt2 + r*tan(22.5 deg) - r) / sqrt2`` in front of the corner
    (measured along the bisector, into the table); the ball falls once its
    center is ``corridor`` past that point.  The capture circle is centered
    ``depth`` behind the corner, so its near edge sits at ``radius - depth``.
    """
    s2 = np.sqrt(2.0)
    corridor_start = (width / s2 + jaw_radius * np.tan(np.pi / 8) - jaw_radius) / s2
    fall_line = corridor_start - corridor
    return float(capture_radius - fall_line)


TABLE_KWARGS = dict(
    l=3.56,
    w=1.78,
    cushion_width=0.055,
    cushion_height=0.0428,  # ~63% of the 68 mm ball
    # Corner pockets: 72.5 mm mouth, 45° straight jaws, 5 mm rounded noses,
    # 5.5 mm corridor, then the ball falls (see module docstring)
    corner_pocket_width=CORNER_POCKET_WIDTH,
    corner_pocket_angle=0.0,
    corner_pocket_depth=_corner_fall_depth(),   # ~31 mm
    corner_pocket_radius=CORNER_CAPTURE_RADIUS,  # must exceed corner_pocket_depth
    corner_jaw_radius=CORNER_JAW_RADIUS,
    # Side pockets: 82.0 mm mouth, 11 mm rounded noses, 5° splay, fall line
    # 5 mm in front of the nose line (radius - depth)
    side_pocket_width=0.082,
    side_pocket_angle=5.0,
    side_pocket_depth=0.035,
    side_pocket_radius=0.040,
    side_jaw_radius=0.011,
    height=0.80,
)

# --- 68 mm / 285 g pyramid balls --------------------------------------------
BALL_M = 0.285
BALL_R = 0.034
BALL_KWARGS = dict(
    m=BALL_M,
    R=BALL_R,
    u_s=0.20,                 # sliding friction on Simonis 950 RusPro tournament cloth
    u_r=0.014,                # rolling friction on real Russian Pyramid cloth
    u_sp_proportionality=0.444,
    u_b=0.055,                # phenolic resin ball-ball friction (cut-induced throw)
    e_b=0.94,                 # 68 mm Aramith ball-ball restitution
)

# --- 700 g / 160 cm Russian Pyramid cue stick -------------------------------
CUE_SPECS_KWARGS = dict(
    brand="Pyramid",
    M=0.700,                  # 700 g (24.7 oz) Russian Pyramid cue
    length=1.60,              # 160 cm standard pyramid cue length
    tip_radius=0.0095,        # dome radius on a 12.7 mm pyramid tip
    shaft_radius_at_tip=0.00635,
    shaft_radius_at_butt=0.0145,
    end_mass=BALL_M / 30,     # shaft end mass scaled to 285 g ball for accurate squirt
)

# Cushion presets: (coefficient of restitution, tangential friction).
# "research" holds the deadened leather-jaw values from the original research
# notes; "tournament" gives realistic rubber rail rebound and cloth friction.
PHYSICS_PRESETS: dict[str, dict[str, float]] = {
    "tournament": {"e_c": 0.76, "f_c": 0.24},
    "research": {"e_c": 0.58, "f_c": 0.40},
}
DEFAULT_PHYSICS_PRESET = "tournament"

MAX_OBJECT_BALLS = 15
CUE_BALL_ID = "cue"

# Aim defaults for a fresh session.  Stun (b=0) keeps the cue ball from
# following straight pots into the pocket.
DEFAULT_CUE_PARAMS = dict(V0=2.2, phi=90.0, theta=0.0, a=0.0, b=0.0)

V0_MIN, V0_MAX = 0.2, 6.5
THETA_MAX = 70.0
SPIN_MAX_RADIUS = 0.50  # real-world miscue limit (~50% of ball radius)

# Pocket ids on a pooltool pocket table: corners lb/lt/rb/rt, sides lc/rc.
CORNER_POCKETS = ("lb", "lt", "rb", "rt")
SIDE_POCKETS = ("lc", "rc")


def table_specs(physics_preset: str = DEFAULT_PHYSICS_PRESET) -> PocketTableSpecs:
    """Table specs; accepts a physics preset name for API symmetry."""
    if physics_preset not in PHYSICS_PRESETS:
        raise ValueError(f"unknown physics preset {physics_preset!r}")
    return PocketTableSpecs(**TABLE_KWARGS)


def build_table(physics_preset: str = DEFAULT_PHYSICS_PRESET) -> pt.Table:
    return pt.Table.from_table_specs(table_specs(physics_preset))


def ball_params(physics_preset: str = DEFAULT_PHYSICS_PRESET) -> dict:
    try:
        preset = PHYSICS_PRESETS[physics_preset]
    except KeyError:
        raise ValueError(f"unknown physics preset {physics_preset!r}") from None
    return {**BALL_KWARGS, **preset}


def cue_specs() -> CueSpecs:
    return CueSpecs(**CUE_SPECS_KWARGS)


def pocket_entry_point(table: pt.Table, pocket_id: str) -> np.ndarray:
    """The point a ball center should travel toward for a dead-center entry.

    For corner pockets that is the table corner itself (the pocket center
    lies beyond the rails); for side pockets it is the pocket center.
    """
    center = np.asarray(table.pockets[pocket_id].center[:2], dtype=float)
    if pocket_id in CORNER_POCKETS:
        return np.array([
            min(max(center[0], 0.0), table.w),
            min(max(center[1], 0.0), table.l),
        ])
    return center
