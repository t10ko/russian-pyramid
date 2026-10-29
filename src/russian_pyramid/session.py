"""Practice session state: the current situation, attempts, and snapshots.

The golden rule: the *situation* is ``self.positions`` plus ``self.cue``
parameters.  A shot snapshots both, so "repeat the same situation" is a single
dict restore.  Attempts are metadata-only (the client caches the frames it
received), so history survives restores and page reloads cheaply.
"""

from __future__ import annotations

import math
import threading
from dataclasses import asdict, dataclass

from russian_pyramid import config, drills, physics
from russian_pyramid.physics import ShotError


@dataclass
class CueParams:
    V0: float = config.DEFAULT_CUE_PARAMS["V0"]
    phi: float = config.DEFAULT_CUE_PARAMS["phi"]
    theta: float = config.DEFAULT_CUE_PARAMS["theta"]
    a: float = config.DEFAULT_CUE_PARAMS["a"]
    b: float = config.DEFAULT_CUE_PARAMS["b"]

    def clamp(self) -> None:
        self.V0 = min(max(self.V0, config.V0_MIN), config.V0_MAX)
        self.phi %= 360.0
        self.theta = min(max(self.theta, 0.0), config.THETA_MAX)
        r = math.hypot(self.a, self.b)
        if r > config.SPIN_MAX_RADIUS:
            scale = config.SPIN_MAX_RADIUS / r
            self.a *= scale
            self.b *= scale

    def as_dict(self) -> dict:
        d = asdict(self)
        return {k: round(v, 4) for k, v in d.items()}


@dataclass
class Attempt:
    n: int
    params: dict
    potted: list[str]
    cushion_hits: int
    duration: float
    cue_potted: bool


class PracticeSession:
    """Single-user session (the app runs locally, one browser tab at a time)."""

    def __init__(self, drill: str = "free",
                 physics_preset: str = config.DEFAULT_PHYSICS_PRESET):
        self.lock = threading.RLock()
        self.physics_preset = physics_preset
        self.cue_ball_id: str = config.CUE_BALL_ID
        self.set_drill(drill, init=True)

    # -- setup ---------------------------------------------------------------

    def set_drill(self, drill: str, init: bool = False) -> None:
        spec = drills.build(drill)
        self.drill = drill
        self.positions: dict[str, tuple[float, float]] = {
            bid: (float(x), float(y)) for bid, (x, y) in spec["balls"].items()
        }
        self.cue_ball_id = config.CUE_BALL_ID
        self.cue = CueParams(phi=spec.get("aim_hint", 90.0))
        self._new_situation()

    def _new_situation(self) -> None:
        self.pre_shot: tuple[dict, dict, str] | None = None
        self.attempts: list[Attempt] = []

    def set_physics_preset(self, preset: str) -> None:
        if preset not in config.PHYSICS_PRESETS:
            raise ValueError(f"unknown physics preset {preset!r}")
        self.physics_preset = preset
        self._new_situation()

    # -- editing the situation ----------------------------------------------

    def _validate_layout(self, positions: dict[str, tuple[float, float]]) -> None:
        if config.CUE_BALL_ID not in positions:
            raise ValueError("layout needs a cue ball")
        objects = [b for b in positions if b != config.CUE_BALL_ID]
        if len(objects) > config.MAX_OBJECT_BALLS:
            raise ValueError(f"at most {config.MAX_OBJECT_BALLS} object balls")
        for x, y in positions.values():
            physics.validate_position(x, y, config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"])
        for bid in list(positions):
            physics.check_overlaps(positions, bid)

    def move_ball(self, ball_id: str, x: float, y: float) -> None:
        if ball_id not in self.positions:
            raise ValueError(f"no ball {ball_id!r}")
        candidate = dict(self.positions)
        candidate[ball_id] = physics.validate_position(
            x, y, config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"])
        physics.check_overlaps(candidate, ball_id)
        self.positions = candidate
        self._new_situation()

    def add_ball(self, x: float, y: float) -> str:
        used = {b for b in self.positions if b != config.CUE_BALL_ID}
        ball_id = next((str(n) for n in range(1, config.MAX_OBJECT_BALLS + 1)
                        if str(n) not in used), None)
        if ball_id is None:
            raise ValueError("table is full")
        candidate = dict(self.positions)
        candidate[ball_id] = physics.validate_position(
            x, y, config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"])
        physics.check_overlaps(candidate, ball_id)
        self.positions = candidate
        self._new_situation()
        return ball_id

    def remove_ball(self, ball_id: str) -> None:
        if ball_id == config.CUE_BALL_ID:
            raise ValueError("cannot remove the cue ball")
        if ball_id not in self.positions:
            raise ValueError(f"no ball {ball_id!r}")
        del self.positions[ball_id]
        if self.cue_ball_id == ball_id:
            self.cue_ball_id = (
                config.CUE_BALL_ID
                if config.CUE_BALL_ID in self.positions
                else next(iter(self.positions), config.CUE_BALL_ID)
            )
        self._new_situation()

    def set_layout(self, balls: dict[str, tuple[float, float]]) -> None:
        positions = {bid: (float(x), float(y)) for bid, (x, y) in balls.items()}
        self._validate_layout(positions)
        self.positions = positions
        if self.cue_ball_id not in self.positions:
            self.cue_ball_id = config.CUE_BALL_ID
        self._new_situation()

    def set_cue_ball(self, ball_id: str) -> None:
        if ball_id not in self.positions:
            raise ValueError(f"no ball {ball_id!r} on table")
        self.cue_ball_id = ball_id

    def respawn_cue(self) -> None:
        """Put the cue ball back after a scratch, at the head spot (nudged free)."""
        table_l = config.TABLE_KWARGS["l"]
        x0, y0 = drills.HEAD_SPOT
        spot = (x0, y0)
        others = [p for bid, p in self.positions.items() if bid != config.CUE_BALL_ID]
        nudge = 0
        while any(math.hypot(spot[0] - ox, spot[1] - oy) < 2 * config.BALL_R + 0.001
                  for ox, oy in others) and nudge < 20:
            nudge += 1
            spot = (x0 + (nudge % 5) * 0.005, min(y0 + nudge * 0.02, table_l - config.BALL_R))
        positions = {bid: xy for bid, xy in self.positions.items()
                     if bid != config.CUE_BALL_ID}
        positions[config.CUE_BALL_ID] = spot
        self._validate_layout(positions)
        self.positions = positions
        self.cue_ball_id = config.CUE_BALL_ID
        self._new_situation()

    # -- shooting -------------------------------------------------------------

    def set_aim(self, params: dict) -> None:
        if "cue_ball_id" in params and params["cue_ball_id"] in self.positions:
            self.cue_ball_id = str(params["cue_ball_id"])
        for key in ("V0", "phi", "theta", "a", "b"):
            if key in params and params[key] is not None:
                setattr(self.cue, key, float(params[key]))
        self.cue.clamp()

    def shoot(self, params: dict | None = None) -> dict:
        with self.lock:
            if params:
                self.set_aim(params)
            if self.cue_ball_id not in self.positions:
                raise ShotError("the selected cue ball is in the pocket -- pick another ball or respawn cue")
            aim = self.cue.as_dict()
            self.pre_shot = (dict(self.positions), dict(aim), self.cue_ball_id)
            struck_ball_id = self.cue_ball_id
            result = physics.simulate(
                self.positions, aim, self.physics_preset, cue_ball_id=struck_ball_id
            )
            cushion_hits = sum(1 for e in result.events
                               if e["type"] in ("cushion", "jaw"))
            attempt = Attempt(
                n=len(self.attempts) + 1,
                params=aim,
                potted=result.potted,
                cushion_hits=cushion_hits,
                duration=result.duration,
                cue_potted=result.cue_potted,
            )
            self.attempts.append(attempt)
            self.positions = {
                bid: xy for bid, xy in result.final_positions.items()
            }
            if self.cue_ball_id not in self.positions and not result.cue_potted:
                if config.CUE_BALL_ID in self.positions:
                    self.cue_ball_id = config.CUE_BALL_ID
                elif self.positions:
                    self.cue_ball_id = sorted(self.positions)[0]
            return self._shot_payload(result, attempt, cue_ball_id=struck_ball_id)

    def predict(self, params: dict | None = None) -> dict:
        with self.lock:
            if params:
                self.set_aim(params)
            if self.cue_ball_id not in self.positions:
                return {"paths": {}, "potted": [], "duration": 0.0}
            return physics.predict_paths(self.positions, self.cue.as_dict(),
                                         self.physics_preset)

    def undo(self) -> None:
        """Restore the situation as it was before the last shot (repeat)."""
        with self.lock:
            if self.pre_shot is None:
                raise ValueError("nothing to repeat yet")
            positions, aim, cue_ball_id = self.pre_shot
            self.positions = {bid: (x, y) for bid, (x, y) in positions.items()}
            self.cue = CueParams(**aim)
            self.cue_ball_id = cue_ball_id if cue_ball_id in self.positions else config.CUE_BALL_ID
            self.pre_shot = None

    # -- serialization ---------------------------------------------------------

    def _shot_payload(
        self,
        result: physics.ShotResult,
        attempt: Attempt,
        cue_ball_id: str | None = None,
    ) -> dict:
        return {
            "frames": result.frames,
            "events": result.events,
            "potted": result.potted,
            "duration": result.duration,
            "cue_potted": result.cue_potted,
            "cue_ball_id": cue_ball_id or self.cue_ball_id,
            "attempt": asdict(attempt),
            "state": self.state(include_table=False),
        }

    def state(self, include_table: bool = True) -> dict:
        payload = {
            "drill": self.drill,
            "drills": drills.catalog(),
            "physics_preset": self.physics_preset,
            "physics_presets": {k: dict(v) for k, v in config.PHYSICS_PRESETS.items()},
            "cue_ball_id": self.cue_ball_id,
            "balls": [
                {"id": bid, "xy": [round(x, 4), round(y, 4)], "is_cue": bid == self.cue_ball_id}
                for bid, (x, y) in sorted(self.positions.items())
            ],
            "ball_radius": config.BALL_R,
            "aim": self.cue.as_dict(),
            "can_undo": self.pre_shot is not None,
            "cue_on_table": self.cue_ball_id in self.positions,
            "attempts": [asdict(a) for a in self.attempts],
            "stats": {
                "shots": len(self.attempts),
                "pots": sum(1 for a in self.attempts if a.potted and not a.cue_potted),
                "scratches": sum(1 for a in self.attempts if a.cue_potted),
            },
        }
        if include_table:
            payload["table"] = physics.serialize_table(config.build_table(self.physics_preset))
        return payload
