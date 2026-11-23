.DEFAULT_GOAL := help
.PHONY: default help setup start app install-app test smoke lint format clean

APP_NAME := Russian Pyramid.app
BUILT_APP := packaging/dist/$(APP_NAME)
INSTALLED_APP := /Applications/$(APP_NAME)

default: help

help:
	@echo "Russian Pyramid commands:"
	@echo "  make setup        Prepare virtualenv and install dependencies"
	@echo "  make start        Start the Russian Pyramid practice table"
	@echo "  make app          Build standalone macOS app bundle ($(BUILT_APP))"
	@echo "  make install-app  Build and replace '$(INSTALLED_APP)' cleanly"
	@echo "  make test         Run pytest suite and UI smoke tests"
	@echo "  make smoke        Run headless UI smoke tests"
	@echo "  make lint         Check code style with ruff"
	@echo "  make format       Format code with ruff"
	@echo "  make clean        Remove temporary caches and build artifacts"

setup:
	@bash scripts/setup.sh

start:
	@if [ ! -f .venv/bin/python ]; then \
		echo "Error: Environment not set up yet. Run 'make setup' first." >&2; \
		exit 1; \
	fi
	@.venv/bin/python -m russian_pyramid.cli $(ARGS)

app:
	@bash packaging/build_macos.sh

install-app: app
	@osascript -e 'tell application "Russian Pyramid" to quit' 2>/dev/null || true
	@rm -rf "$(INSTALLED_APP)"
	@ditto "$(BUILT_APP)" "$(INSTALLED_APP)"
	@xattr -cr "$(INSTALLED_APP)" 2>/dev/null || true
	@codesign --verify --deep --strict "$(INSTALLED_APP)"
	@touch "$(INSTALLED_APP)"
	@/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$(INSTALLED_APP)" 2>/dev/null || true
	@echo "Installed: $(INSTALLED_APP)"

test:
	@.venv/bin/pytest
	@node scripts/ui_smoke.mjs

smoke:
	@node scripts/ui_smoke.mjs

lint:
	@.venv/bin/ruff check .

format:
	@.venv/bin/ruff format .

clean:
	@rm -rf .pytest_cache .ruff_cache build dist packaging/build packaging/dist *.egg-info src/*.egg-info
	@find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
