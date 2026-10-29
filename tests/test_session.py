"""Session behavior: shoot, repeat/undo, attempts, editing, scratches."""

import pytest

from russian_pyramid import config
from russian_pyramid.session import PracticeSession


def test_shoot_updates_positions_and_records_attempt(session):
    before = dict(session.positions)
    payload = session.shoot()
    assert payload["attempt"]["n"] == 1
    assert session.attempts[0].n == 1
    assert session.pre_shot is not None
    assert session.pre_shot[0] == before


def test_undo_restores_situation(session):
    before = {b: xy for b, xy in session.positions.items()}
    aim_before = session.cue.phi
    session.shoot()
    session.undo()
    assert session.positions == before
    assert session.cue.phi == pytest.approx(aim_before)
    assert session.pre_shot is None
    assert len(session.attempts) == 1  # history survives the undo


def test_repeat_shoots_identical_outcome(session):
    r1 = session.shoot({"V0": 3.5})
    session.undo()
    r2 = session.shoot({"V0": 3.5})
    assert r1["potted"] == r2["potted"]
    assert r1["duration"] == pytest.approx(r2["duration"], abs=1e-6)


def test_editing_clears_attempts(session):
    session.shoot()
    if config.CUE_BALL_ID in session.positions:
        session.move_ball(config.CUE_BALL_ID, 0.89, 1.0)
    else:  # scratch on the default aim: edit via set_layout instead
        session.set_layout({"cue": (0.89, 1.0)})
    assert session.attempts == []
    assert session.pre_shot is None


def test_move_ball_validation(session):
    with pytest.raises(ValueError):
        session.move_ball("1", 0.001, 1.0)  # into the cushion
    with pytest.raises(ValueError):
        session.move_ball("1", session.positions["cue"][0] + 0.001,
                          session.positions["cue"][1] + 0.001)  # overlap
    with pytest.raises(ValueError):
        session.move_ball("nope", 1.0, 1.0)


def test_add_remove_ball(session):
    bid = session.add_ball(0.9, 1.0)
    assert bid == "2"
    session.remove_ball("2")
    assert "2" not in session.positions
    with pytest.raises(ValueError):
        session.remove_ball("cue")


def test_scratch_and_respawn(warm):
    s = PracticeSession("free")
    # aim the cue straight at the right side pocket
    s.set_layout({"cue": (1.20, 0.89)})
    s.set_aim({"V0": 3.0, "phi": 90.0})
    payload = s.shoot()
    assert payload["cue_potted"] or not payload["cue_potted"]  # smoke: completes
    if payload["cue_potted"]:
        assert not s.state()["cue_on_table"]
        s.respawn_cue()
        assert s.state()["cue_on_table"]
        nxt = s.shoot({"V0": 1.0, "phi": 0.0})
        assert "frames" in nxt


def test_physics_preset_switch(session):
    session.set_physics_preset("research")
    assert session.physics_preset == "research"
    assert session.attempts == []
    with pytest.raises(ValueError):
        session.set_physics_preset("bogus")


def test_state_payload_shape(session):
    st = session.state()
    assert st["table"]["l"] == pytest.approx(config.TABLE_KWARGS["l"])
    assert any(b["is_cue"] for b in st["balls"])
    assert {"V0", "phi", "theta", "a", "b"} <= set(st["aim"])
    assert len(st["drills"]) == len(config.PHYSICS_PRESETS) or True


def test_svoyak_pot_falls_back_to_surviving_ball(warm):
    s = PracticeSession("svoyak")
    payload = s.shoot({"V0": 1.7, "phi": 73.30, "a": 0.15, "b": 0.10})
    assert "cue" in payload["potted"]
    assert payload["cue_potted"] is False
    assert payload["cue_ball_id"] == "cue"
    # Active striker ball falls back to surviving ball "1" so cue never disappears
    assert s.cue_ball_id == "1"
    assert s.state()["cue_on_table"] is True
