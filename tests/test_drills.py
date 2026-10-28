"""Every drill must build a legal, on-table, non-overlapping layout."""

import math

import pytest

from russian_pyramid import config, drills


def _assert_legal(layout, drill_id):
    balls = layout["balls"]
    assert "cue" in balls
    w = config.TABLE_KWARGS["w"]
    table_l = config.TABLE_KWARGS["l"]
    r = config.BALL_R
    positions = []
    for bid, (x, y) in balls.items():
        assert r - 1e-9 <= x <= w - r + 1e-9, f"{drill_id}/{bid} off table x={x:.3f}"
        assert r - 1e-9 <= y <= table_l - r + 1e-9, f"{drill_id}/{bid} off table y={y:.3f}"
        positions.append((bid, x, y))
    for i in range(len(positions)):
        for j in range(i + 1, len(positions)):
            _, x1, y1 = positions[i]
            _, x2, y2 = positions[j]
            assert math.hypot(x1 - x2, y1 - y2) >= 2 * r - 1e-6, \
                f"{drill_id}: overlapping balls {positions[i][0]} / {positions[j][0]}"
    assert 0 <= layout["aim_hint"] < 360


def test_catalog_ids_match():
    assert [c["id"] for c in drills.catalog()] == drills.names()


@pytest.mark.parametrize("drill_id", drills.names())
def test_drill_builds_legally(drill_id):
    _assert_legal(drills.build(drill_id), drill_id)


def test_rack_has_fifteen_balls():
    layout = drills.build("rack")
    balls = layout["balls"]
    assert len(balls) == 16  # cue + 15
    assert sorted(int(b) for b in balls if b != "cue") == list(range(1, 16))


def test_unknown_drill_raises():
    with pytest.raises(ValueError):
        drills.build("nope")


def test_ghost_aim_points_at_target(warm=None):
    from russian_pyramid.physics import ghost_aim as ga

    layout = drills.build("straight_corner")
    phi = ga(layout["balls"], "1", (config.TABLE_KWARGS["w"], config.TABLE_KWARGS["l"]))
    # object ball sits lower-left of the corner -> cue aims up-right (~45 deg)
    assert 40 < phi < 50
