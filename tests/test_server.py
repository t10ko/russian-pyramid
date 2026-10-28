"""HTTP API smoke tests over a loopback server."""

import json
import threading
import urllib.request

import pytest

from russian_pyramid.server import make_server
from russian_pyramid.session import PracticeSession


@pytest.fixture(scope="module")
def base_url(warm):
    session = PracticeSession("straight_corner")
    httpd = make_server(session, "127.0.0.1", 0)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()


def get(url, path):
    with urllib.request.urlopen(url + path) as res:
        return res.status, json.loads(res.read())


def post(url, path, body):
    req = urllib.request.Request(
        url + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def test_index_html(base_url):
    with urllib.request.urlopen(base_url + "/") as res:
        assert res.status == 200
        assert b"Russian Pyramid" in res.read()


def test_state(base_url):
    status, data = get(base_url, "/api/state")
    assert status == 200
    assert data["table"]["w"] > 1
    assert data["cue_on_table"] is True


def test_static_js(base_url):
    with urllib.request.urlopen(base_url + "/js/main.js") as res:
        assert res.status == 200


def test_shoot_and_undo(base_url):
    status, data = post(base_url, "/api/shoot", {"params": {"V0": 3.5, "phi": 45.0}})
    assert status == 200
    assert "frames" in data and "events" in data
    assert data["state"]["can_undo"] is True

    status, data = post(base_url, "/api/undo", {})
    assert status == 200
    assert data["can_undo"] is False


def test_validation_errors(base_url):
    status, data = post(base_url, "/api/balls/move", {"id": "1", "xy": [0.001, 0.5]})
    assert status == 422
    assert "error" in data

    status, data = post(base_url, "/api/drill", {"name": "bogus"})
    assert status in (422, 500)


def test_drill_switch_and_shoot(base_url):
    status, data = post(base_url, "/api/drill", {"name": "side_straight"})
    assert status == 200
    status, data = post(base_url, "/api/shoot", {})
    assert status == 200
    assert data["attempt"]["n"] >= 1


def test_predict(base_url):
    status, data = post(base_url, "/api/predict", {"params": {"V0": 2.0, "phi": 90.0}})
    assert status == 200
    assert "paths" in data
