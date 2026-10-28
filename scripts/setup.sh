#!/usr/bin/env bash
# scripts/setup.sh - Prepare virtual environment and dependencies for Russian Pyramid
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== Russian Pyramid: Setup ==="

find_python() {
    for cmd in python3.12 python3.11 python3.10 python3; do
        if command -v "$cmd" >/dev/null 2>&1; then
            ver=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || true)
            major=$(echo "$ver" | cut -d. -f1)
            minor=$(echo "$ver" | cut -d. -f2)
            if [ "$major" -eq 3 ] && [ "$minor" -ge 10 ] && [ "$minor" -le 13 ]; then
                echo "$cmd"
                return 0
            fi
        fi
    done
    return 1
}

if command -v uv >/dev/null 2>&1; then
    echo "Found uv: $(uv --version)"
    if [ ! -d ".venv" ]; then
        echo "Creating virtual environment with uv (Python 3.12)..."
        uv venv .venv --python 3.12 2>/dev/null || uv venv .venv --python ">=3.10,<3.14" 2>/dev/null || uv venv .venv
    else
        echo "Virtual environment .venv already exists."
    fi
    echo "Installing project dependencies (editable + dev)..."
    uv pip install -e ".[dev]"
else
    echo "uv not found. Looking for a compatible Python (3.10 - 3.13)..."
    if PYTHON_CMD=$(find_python); then
        echo "Found compatible Python: $PYTHON_CMD ($($PYTHON_CMD --version))"
        if [ ! -d ".venv" ]; then
            echo "Creating virtual environment..."
            "$PYTHON_CMD" -m venv .venv
        else
            echo "Virtual environment .venv already exists."
        fi
        echo "Upgrading pip and installing project dependencies..."
        .venv/bin/python -m pip install --upgrade pip
        .venv/bin/python -m pip install -e ".[dev]"
    else
        echo "Error: No compatible Python found (requires >=3.10, <3.14)." >&2
        echo "Please install uv ('brew install uv') or Python 3.12 ('brew install python@3.12')." >&2
        exit 1
    fi
fi

if command -v node >/dev/null 2>&1; then
    echo "Found Node.js: $(node --version) (ready for UI smoke tests)"
else
    echo "Notice: Node.js not found in PATH (optional, needed for 'make smoke')"
fi

echo
echo "Setup complete! You can now start the practice room with:"
echo "  make start"
