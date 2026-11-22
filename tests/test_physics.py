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


def test_corner_fall_line_at_end_of_corridor():
    """Regulation: 5-6 mm parallel corridor, then the ball drops."""
    table = config.build_table()
    pocket = table.pockets["lb"]
    # capture circle's near edge, measured along the bisector into the table
    center_u = (pocket.center[0] + pocket.center[1]) / math.sqrt(2)
    fall_line = center_u + pocket.radius
    jaw = config.TABLE_KWARGS["corner_jaw_radius"]
    width = config.TABLE_KWARGS["corner_pocket_width"]
    corridor_start = (width / math.sqrt(2) + jaw * math.tan(math.pi / 8) - jaw) / math.sqrt(2)
    assert corridor_start - fall_line == pytest.approx(config.CORNER_CORRIDOR, abs=1e-6)
    assert 0.005 <= config.CORNER_CORRIDOR <= 0.006


def test_pocket_event_carries_entry_state(warm):
    result = physics.simulate(bisector_positions(), {"V0": 3.5, "phi": PHI})
    pots = [e for e in result.events if e["type"] == "pocket"]
    assert pots and pots[0]["pocket"] == "rt"
    vx, vy = pots[0]["vel"]
    assert vx > 0 and vy > 0                    # heading into the top-right corner
    assert len(pots[0]["xy"]) == 2


def test_predict_target_tracks_struck_ball(warm):
    out = physics.predict_target(bisector_positions(), {"V0": 3.5, "phi": PHI})
    assert out["target"] == "1"
    assert out["potted"] is True and out["pocket"] == "rt"
    pts = out["path"]["xyz"]
    assert len(pts) >= 2 and len(pts) == len(out["path"]["t"])
    # path runs from the object ball toward the corner
    assert pts[-1][0] > pts[0][0] and pts[-1][1] > pts[0][1]


def test_predict_target_without_contact(warm):
    out = physics.predict_target(bisector_positions(), {"V0": 2.0, "phi": PHI + 90})
    assert out["target"] is None and out["path"]["xyz"] == []
    assert out["contact"] is None
    assert len(out["cue"]["path"]["xyz"]) > 2      # the cue ball still has a path


def test_predict_target_contact_is_first_touch(warm):
    pos = bisector_positions()
    out = physics.predict_target(pos, {"V0": 3.5, "phi": PHI})
    cue_at, obj_at = out["contact"]["cue"], out["contact"]["target"]
    # balls touch at contact, and the object ball hasn't moved yet
    assert math.dist(cue_at, obj_at) == pytest.approx(2 * config.BALL_R, abs=1e-3)
    assert math.dist(obj_at, pos["1"]) < 1e-3
    assert out["cue"]["path"]["xyz"][0][:2] == pytest.approx(list(pos["cue"]), abs=1e-3)


def test_predict_target_follows_squirt_not_the_line(warm):
    """Heavy side spin squirts the cue ball off the cue line: a thin clip on
    the line becomes a clean miss (or vice versa) -- the preview must follow
    the physics, i.e. the first ball actually touched."""
    # the straight cue line overlaps ball "1" by 12 mm: geometrically a hit
    pos = {"cue": (0.89, 1.0), "1": (0.89 + 2 * config.BALL_R - 0.012, 2.5)}
    assert physics.predict_target(pos, {"V0": 3.0, "phi": 90.0})["target"] == "1"
    squirted = physics.predict_target(pos, {"V0": 3.0, "phi": 90.0, "a": -0.45})
    shot = physics.simulate(pos, {"V0": 3.0, "phi": 90.0, "a": -0.45})
    assert not any(e["type"] == "ball_ball" for e in shot.events)  # squirt -> clean miss
    assert squirted["target"] is None and squirted["contact"] is None


def test_predict_target_shows_svoyak(warm):
    """Cue ball dropping after the contact is reported on the cue path."""
    import numpy as np

    corner = np.array([config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"]])
    u = np.array([1.0, 1.0]) / math.sqrt(2)
    cue = corner - u * 0.6
    obj = cue - u * 0.4  # object ball *behind* the cue ball: no contact, cue drops
    out = physics.predict_target({"cue": tuple(cue), "1": tuple(obj)}, {"V0": 1.5, "phi": PHI})
    assert out["target"] is None
    assert out["cue"]["potted"] is True and out["cue"]["pocket"] == "rt"


def test_pocket_jaws_soft_vs_firm_and_predict_consistency(warm):
    """Soft jaw grazes roll in, firm jaw grazes deaden near the mouth, and
    predict_target uses the exact same split rail/jaw engine as simulate."""
    pos = bisector_positions()
    soft = {"V0": 1.1, "phi": PHI - 0.08}
    firm = {"V0": 2.0, "phi": PHI - 0.08}

    soft_shot = physics.simulate(pos, soft)
    firm_shot = physics.simulate(pos, firm)
    assert "1" in soft_shot.potted
    assert "1" not in firm_shot.potted
    # Softened jaws deaden the rejected ball near the corner mouth ("в губах")
    end_x, end_y = firm_shot.final_positions["1"]
    assert math.hypot(config.TABLE_KWARGS["w"] - end_x, config.TABLE_KWARGS["l"] - end_y) < 0.25

    assert physics.predict_target(pos, soft)["potted"] is True
    assert physics.predict_target(pos, firm)["potted"] is False


def test_main_rails_remain_lively(warm):
    """Main rubber rails keep lively tournament rebound (unlike deadened jaws)."""
    shot = physics.simulate({"cue": (0.89, 1.20)}, {"V0": 2.5, "phi": 0.0})
    rail_hits = sum(1 for e in shot.events if e["type"] == "cushion")
    # At V0 = 2.5 m/s across the 1.78 m width, lively rails rebound across multiple rails
    assert rail_hits >= 2
