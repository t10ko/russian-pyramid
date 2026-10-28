"""Bridge between the app and the pooltool physics engine.

Every shot is simulated from scratch: a fresh :class:`pt.System` is built from
a plain ``{ball_id: (x, y)}`` layout plus cue parameters, simulated, and packed
into JSON-friendly frames/events.  Keeping layouts as plain data makes undo,
repeat, and drill resets trivial and avoids pooltool object lifecycle issues
(potted balls, stale histories, deep copies).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pooltool as pt
from pooltool.events import EventType

from russian_pyramid import config

# Events the UI cares about (ripples, pot animation, outcome).
_EVENT_TYPES = {
    EventType.BALL_BALL: "ball_ball",
    EventType.BALL_LINEAR_CUSHION: "cushion",
    EventType.BALL_CIRCULAR_CUSHION: "jaw",
    EventType.BALL_POCKET: "pocket",
}

_FRAME_DT = 1 / 120  # continuize sample rate for shot playback
_PREDICT_STEP = 4  # downsample 120 Hz -> 30 Hz for aim-assist paths
_MAX_FRAME_COUNT = 900  # per ball; halves the rate for very long shots


class ShotError(RuntimeError):
    """Raised when pooltool cannot simulate a shot (degenerate setups etc.)."""


@dataclass(slots=True)
class ShotResult:
    frames: dict[str, dict]      # ball_id -> {"t": [...], "xy": [[x, y], ...]}
    events: list[dict]           # {"t", "type", "balls": [ids]}
    potted: list[str]            # ball ids potted, in order
    duration: float              # simulated shot duration (s)
    final_positions: dict[str, tuple[float, float]]  # survivors only
    cue_potted: bool


def build_system(
    positions: dict[str, tuple[float, float]],
    cue_params: dict,
    table: pt.Table | None = None,
    physics_preset: str = config.DEFAULT_PHYSICS_PRESET,
    cue_ball_id: str = config.CUE_BALL_ID,
) -> pt.System:
    table = table or config.build_table(physics_preset)
    params = config.ball_params(physics_preset)
    balls = {bid: pt.Ball.create(bid, xy=xy, **params) for bid, xy in positions.items()}
    cue = pt.Cue(cue_ball_id=cue_ball_id, specs=config.cue_specs())
    system = pt.System(table=table, balls=balls, cue=cue)
    system.cue.set_state(
        V0=float(cue_params["V0"]),
        phi=float(cue_params["phi"]),
        theta=float(cue_params.get("theta", 0.0)),
        a=float(cue_params.get("a", 0.0)),
        b=float(cue_params.get("b", 0.0)),
        cue_ball_id=cue_ball_id,
    )
    return system


def simulate(positions: dict[str, tuple[float, float]], cue_params: dict,
             physics_preset: str = config.DEFAULT_PHYSICS_PRESET,
             cue_ball_id: str = config.CUE_BALL_ID) -> ShotResult:
    """Simulate a shot and pack everything the UI needs."""
    system = build_system(
        positions, cue_params, physics_preset=physics_preset, cue_ball_id=cue_ball_id
    )
    try:
        pt.simulate(system, inplace=True, continuous=True, dt=_FRAME_DT)
    except Exception as exc:  # numba asserts, degenerate overlaps, ...
        raise ShotError(f"pooltool could not simulate this shot: {exc}") from exc
    return _pack(system, cue_ball_id=cue_ball_id)


def _pack(system: pt.System, cue_ball_id: str = config.CUE_BALL_ID) -> ShotResult:
    ball_ids = set(system.balls)
    frames: dict[str, dict] = {}
    for bid, ball in system.balls.items():
        rvw, _states, times = (np.asarray(a) for a in ball.history_cts.vectorize())
        step = 1 if len(times) <= _MAX_FRAME_COUNT else 2
        frames[bid] = {
            "t": [round(float(t), 4) for t in times[::step]],
            "xyz": [
                [round(float(x), 4), round(float(y), 4), round(float(z), 4)]
                for x, y, z in zip(
                    rvw[::step, 0, 0], rvw[::step, 0, 1], rvw[::step, 0, 2], strict=True)
            ],
            "w": [
                [round(float(wx), 3), round(float(wy), 3), round(float(wz), 3)]
                for wx, wy, wz in zip(
                    rvw[::step, 2, 0], rvw[::step, 2, 1], rvw[::step, 2, 2], strict=True)
            ],
        }

    events = []
    potted: list[str] = []
    for e in system.events:
        kind = _EVENT_TYPES.get(e.event_type)
        if kind is None:
            continue
        ids = sorted({a.id for a in e.agents if a.id in ball_ids})
        events.append({"t": round(float(e.time), 4), "type": kind, "balls": ids})
        if kind == "pocket":
            potted.extend(ids)

    final_positions = {
        bid: (float(b.state.rvw[0, 0]), float(b.state.rvw[0, 1]))
        for bid, b in system.balls.items()
        if bid not in potted
    }
    duration = max((f["t"][-1] for f in frames.values()), default=0.0)
    hit_object_ball = any(
        e["type"] == "ball_ball" and cue_ball_id in e["balls"] for e in events
    )
    return ShotResult(
        frames=frames,
        events=events,
        potted=potted,
        duration=round(duration, 3),
        final_positions=final_positions,
        cue_potted=(cue_ball_id in potted) and not hit_object_ball,
    )


def predict_paths(positions: dict[str, tuple[float, float]], cue_params: dict,
                  physics_preset: str = config.DEFAULT_PHYSICS_PRESET) -> dict:
    """Full-runout paths for the aim assist (downsampled)."""
    result = simulate(positions, cue_params, physics_preset)
    paths = {
        bid: {"t": f["t"][_PREDICT_STEP::_PREDICT_STEP],
              "xyz": f["xyz"][_PREDICT_STEP::_PREDICT_STEP]}
        for bid, f in result.frames.items()
    }
    return {"paths": paths, "potted": result.potted, "duration": result.duration}


def serialize_table(table: pt.Table) -> dict:
    """Table geometry for the renderer: exactly what the solver collides with."""
    linear = []
    for seg in table.cushion_segments.linear.values():
        linear.append({
            "p1": [round(float(seg.p1[0]), 4), round(float(seg.p1[1]), 4)],
            "p2": [round(float(seg.p2[0]), 4), round(float(seg.p2[1]), 4)],
        })
    circular = []
    for seg in table.cushion_segments.circular.values():
        circular.append({
            "center": [round(float(seg.center[0]), 4), round(float(seg.center[1]), 4)],
            "radius": round(float(seg.radius), 4),
        })
    pockets = [
        {
            "id": pid,
            "center": [round(float(p.center[0]), 4), round(float(p.center[1]), 4)],
            "radius": round(float(p.radius), 4),
        }
        for pid, p in table.pockets.items()
    ]
    return {
        "l": table.l,
        "w": table.w,
        "cushion_width": config.TABLE_KWARGS["cushion_width"],
        "linear_segments": linear,
        "circular_segments": circular,
        "pockets": pockets,
    }


def ghost_aim(positions: dict[str, tuple[float, float]], ball_id: str,
              target: tuple[float, float]) -> float:
    """Cue phi that sends ``ball_id`` toward ``target`` (ghost-ball construction).

    The cue must be placed on the line through target and the object ball;
    this returns the direction from the cue ball to the ghost-ball point.
    """
    obj = np.asarray(positions[ball_id], dtype=float)
    tgt = np.asarray(target, dtype=float)
    u = tgt - obj
    dist = np.linalg.norm(u)
    if dist < 1e-6:
        raise ValueError("target coincides with ball")
    u /= dist
    ghost = obj - u * (2 * config.BALL_R)
    cue = np.asarray(positions[config.CUE_BALL_ID], dtype=float)
    delta = ghost - cue
    if np.linalg.norm(delta) < 1e-6:
        raise ValueError("cue ball sits on the ghost-ball point")
    return float(math.degrees(math.atan2(delta[1], delta[0])) % 360.0)


def validate_position(x: float, y: float, w: float, table_l: float) -> tuple[float, float]:
    r = config.BALL_R
    if not (r <= x <= w - r and r <= y <= table_l - r):
        raise ValueError("ball must sit fully inside the cushions")
    return float(x), float(y)


def check_overlaps(positions: dict[str, tuple[float, float]], moving: str) -> None:
    min_dist = 2 * config.BALL_R + 0.0005
    mx, my = positions[moving]
    for bid, (x, y) in positions.items():
        if bid == moving:
            continue
        if math.hypot(x - mx, y - my) < min_dist:
            raise ValueError(f"overlaps ball {bid}")
