"""Pocket rattle experiment: dead-center pot vs a 0.25-degree miss.

This is the headless validation script behind the app's pocket tuning.  It
builds a 12-foot Russian Pyramid table with the app's configuration and runs
two shots into a 74 mm corner pocket -- one aimed dead-center along the pocket
bisector, one off by a quarter of a degree -- and prints what happened.

Run it with the app installed:

    russian-pyramid --no-browser &      # not required, just for context
    .venv/bin/python examples/pocket_rattle_test.py

Notes for readers porting older pooltool scripts to pooltool-billiards 0.6:

* ``pt.PocketTableSpecs`` moved to ``pooltool.objects.table.specs``.
* Pocket ids are ``lb, lc, lt, rb, rc, rt`` (not ``tr``).
* Aim dead-center entries along the corner *bisector*, not at the pocket
  center (which sits outside the rails).
* ``corner_pocket_radius`` must exceed ``corner_pocket_depth``, or the pocket
  can never capture the ball.
"""

import numpy as np
import pooltool as pt
from pooltool.events import EventType
from pooltool.objects.table.specs import PocketTableSpecs

from russian_pyramid import config


def build_table() -> pt.Table:
    return pt.Table.from_table_specs(PocketTableSpecs(**config.TABLE_KWARGS))


def bisector_shot(aim_offset_deg: float = 0.0, speed: float = 3.5,
                  table: pt.Table | None = None) -> pt.System:
    """Cue and object ball on the top-right corner bisector."""
    corner = np.array([config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"]])
    u = np.array([1.0, 1.0]) / np.sqrt(2)              # toward the corner
    obj = corner - u * 0.75
    cue = obj - u * (2 * config.BALL_R + 0.60)         # behind the ghost ball

    params = config.ball_params()
    balls = {
        "cue": pt.Ball.create("cue", xy=tuple(cue), **params),
        "1": pt.Ball.create("1", xy=tuple(obj), **params),
    }
    system = pt.System(table=table or build_table(), balls=balls,
                       cue=pt.Cue(cue_ball_id="cue"))
    system.cue.set_state(
        V0=speed,
        phi=45.0 + aim_offset_deg,   # 45 deg == the corner bisector
        theta=0.0, a=0.0, b=0.0,     # level cue, stun
    )
    pt.simulate(system, inplace=True)
    return system


def report(name: str, system: pt.System) -> None:
    potted = [
        a.id for e in system.events
        if e.event_type == EventType.BALL_POCKET for a in e.agents
        if a.id in system.balls
    ]
    cushion_hits = sum(
        1 for e in system.events
        if e.event_type in (EventType.BALL_LINEAR_CUSHION, EventType.BALL_CIRCULAR_CUSHION)
    )
    verdict = "POTTED" if potted else ("RATTLED OUT" if cushion_hits else "MISSED")
    potted_str = ",".join(potted) if potted else "-"
    print(f"{name:38s} potted={potted_str:12s} cushion_hits={cushion_hits:2d}  -> {verdict}")


if __name__ == "__main__":
    table = build_table()
    print(f"Russian Pyramid table {table.l:.2f} x {table.w:.2f} m, "
          f"corner mouth {config.TABLE_KWARGS['corner_pocket_width'] * 1000:.0f} mm\n")
    report("dead center (0.00 deg)", bisector_shot(0.0, table=table))
    report("off by 0.10 deg", bisector_shot(0.10, table=table))
    report("off by 0.25 deg", bisector_shot(0.25, table=table))
    report("off by 0.50 deg", bisector_shot(0.50, table=table))
    print("\nThat gap between line 1 and line 3 is the whole game.")
