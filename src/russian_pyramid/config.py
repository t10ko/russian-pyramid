"""Russian Pyramid table, ball, and cushion physics configuration.

Everything here was validated empirically against pooltool 0.6:

* Corner pockets capture a ball only when its center passes within
  ``corner_pocket_radius`` of the pocket center, which sits exactly
  ``corner_pocket_depth`` beyond the corner along the diagonal.  The capture
  radius therefore MUST exceed the depth or the pocket is geometrically
  un-pottable.  With a 55 mm capture radius and 45 mm depth, a dead-center
  ball drops and ~0.1 degrees of aim error rattles in the jaws -- the
  signature brutality of a real 72--74 mm pyramid pocket.
* The mouth is measured between jaw-tip circles, so the free gap for a
  68 mm ball is (74 mm - 2*1.5 mm) = 71 mm: about 1.5 mm of slack per side.
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
TABLE_KWARGS = dict(
    l=3.56,
    w=1.78,
    cushion_width=0.055,
    cushion_height=0.0428,  # ~63% of the 68 mm ball
    # Corner pockets: 72.5 mm mouth, 45° straight jaws, 8 mm rounded jaw horns
    corner_pocket_width=0.0725,
    corner_pocket_angle=0.0,
    corner_pocket_depth=0.045,
    corner_pocket_radius=0.055,  # must exceed corner_pocket_depth (see module docstring)
    corner_jaw_radius=0.008,
    # Side pockets: 82.0 mm mouth, 14 mm rounded jaw horns, 5° splay
    side_pocket_width=0.082,
    side_pocket_angle=5.0,
    side_pocket_depth=0.015,
    side_pocket_radius=0.035,
    side_jaw_radius=0.014,
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
