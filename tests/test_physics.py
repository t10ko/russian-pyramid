"""Physics configuration: the pocket behavior that defines the app."""

import math

import pytest

from russian_pyramid import config, physics


def test_table_geometry():
    table = config.build_table()
    assert table.l == pytest.approx(3.56)
    assert table.w == pytest.approx(1.78)
    assert set(table.pockets) == {"lb", "lc", "lt", "rb", "rc", "rt"}
    # capture radius must exceed corner depth or the pocket can never pot
    assert config.TABLE_KWARGS["corner_pocket_radius"] > config.TABLE_KWARGS["corner_pocket_depth"]


def test_serialize_table_roundtrip():
    data = physics.serialize_table(config.build_table())
    assert data["l"] == pytest.approx(3.56)
    assert len(data["pockets"]) == 6
    assert len(data["linear_segments"]) == 18
    assert len(data["circular_segments"]) == 12
    for seg in data["linear_segments"]:
        assert len(seg["p1"]) == 2 and len(seg["p2"]) == 2


def bisector_positions(obj_dist=0.75, cue_dist=0.60):
    """Object ball on the top-right corner bisector, cue behind it."""
    import numpy as np

    corner = np.array([config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"]])
    u = np.array([1.0, 1.0]) / math.sqrt(2)
    obj = corner - u * obj_dist
    cue = obj - u * (cue_dist + 2 * config.BALL_R)
    return {"cue": (cue[0], cue[1]), "1": (obj[0], obj[1])}


PHI = 45.0  # from lower-left toward the top-right corner


def test_dead_center_corner_pot(warm):
    result = physics.simulate(bisector_positions(), {"V0": 3.5, "phi": PHI})
    assert "1" in result.potted
    assert result.cue_potted is False


def test_small_aim_error_rattles(warm):
    """0.25 degrees off -> rejected by the jaws. This is the app's identity."""
    result = physics.simulate(bisector_positions(), {"V0": 3.5, "phi": PHI + 0.25})
    assert "1" not in result.potted
    assert any(e["type"] in ("cushion", "jaw") for e in result.events)


def test_frames_are_packed(warm):
    result = physics.simulate(bisector_positions(), {"V0": 2.0, "phi": PHI})
    assert set(result.frames) == {"cue", "1"}
    for frames in result.frames.values():
        assert len(frames["t"]) == len(frames["xyz"])
        assert len(frames["t"]) == len(frames["w"])
        assert all(len(p) == 3 for p in frames["xyz"])  # x, y, z
        assert all(len(w) == 3 for w in frames["w"])    # wx, wy, wz
        assert frames["t"][0] == pytest.approx(0.0)
        assert frames["t"][-1] > 0.5


def test_predict_paths(warm):
    out = physics.predict_paths(bisector_positions(), {"V0": 3.5, "phi": PHI})
    assert "1" in out["paths"] and "cue" in out["paths"]
    assert out["duration"] > 0


def test_degenerate_setup_never_crashes(warm):
    """Overlapping balls must not propagate a raw pooltool exception."""
    try:
        result = physics.simulate(
            {"cue": (0.89, 1.78), "1": (0.89 + 0.001, 1.78)},  # overlapping
            {"V0": 2.0, "phi": 0.0},
        )
        assert isinstance(result, physics.ShotResult)
    except physics.ShotError:
        pass  # also acceptable: pooltool rejected the setup
