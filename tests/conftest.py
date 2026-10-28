import pytest

from russian_pyramid.session import PracticeSession


@pytest.fixture(scope="session")
def warm():
    """First pooltool simulate compiles numba kernels; pay it once."""
    session = PracticeSession("straight_corner")
    session.predict({"V0": 1.0})
    return session


@pytest.fixture
def session(warm):
    return PracticeSession("straight_corner")
