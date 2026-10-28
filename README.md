# Russian Pyramid — 3D Practice Table

A repetition-focused **Russian Pyramid** (Pyramid / Русский бильярд) test ground and physics workbench: a regulation 12-ft table modeled with authentic [pooltool](https://pooltool.readthedocs.io) physics, 3D orbit and TV cameras, fine aim and spin controls, full runout replay with trails, and an instant **repeat situation** loop so you can drill difficult shots until you master them.

> *Not a casual arcade game — a precision practice room.*

---

## Screenshots

### 3D Practice Workbench
![Russian Pyramid 3D Test Ground](assets/preview.png)
*Interactive 3D view: dynamic cue aiming with spin indicator, aim line, power/elevation sliders, and attempt tracker.*

<br/>

### Full 15-Ball Pyramid Rack
![Full 15-ball pyramid rack](assets/rack.png)
*Standard 15-ball pyramid rack on the foot spot ready for break practice.*

<br/>

### Top-Down Table & Pocket Geometry
![Top-down table view](assets/top_view.png)
*Regulation 3.56 × 1.78 m playing surface, head string and spots, and authentic 74 mm tight corner mouths with straight jaws.*

<br/>

### In-Game Controls & Keybindings
![Controls and practice workbench](assets/help.png)
*Built-in controls reference accessible anytime by pressing <kbd>?</kbd> or clicking Help.*

---

## Key Features

- **True 3D Camera System**:
  - Drag to orbit freely; scroll wheel to zoom.
  - Camera dynamically follows whatever ball you click (cue ball by default).
  - One-click presets: **TV angle** (framed over the shoulder of the active ball) and **Top-down** perspective.
- **Authentic 12-ft Tournament Geometry**:
  - 3.56 × 1.78 m playing surface.
  - 74 mm corner pocket mouths with sharp 1.5 mm horns and straight jaws (for 68 mm balls, allowing merely ±0.1° error along the bisector).
  - 82 mm side pockets.
  - Recessed extruded pocket slots and cloth markings (head string + spots).
- **Realistic Event-Based Physics** via `pooltool-billiards`:
  - 68 mm / 285 g Aramith tournament balls.
  - Full rolling, sliding, and spinning regimes.
  - Follow, draw, english (side spin), elevated-cue massé curves, and cut-induced throw.
  - Pockets modeled with real jaw rattle, lip bounce, and drop animations.
- **Dedicated Practice Loop**:
  - Aim, set spin and power, shoot.
  - Replay shot with time scrubbing, adjustable playback speed (0.5× – 4×), and ball motion trails.
  - Press <kbd>R</kbd> or <kbd>U</kbd> to return instantly to the pre-shot layout.
  - Log attempts with parameters and outcome metrics (potted, missed, scratch).
- **Flexible Layouts & Drills**:
  - Start with a full rack (<kbd>N</kbd>), empty table, straight corner, cuts, or caroms (`--drill`).
  - Switch to **Place balls mode** (<kbd>M</kbd>) to drag balls anywhere, click to spawn balls, or right-click to remove.

---

## Quickstart

```bash
make setup    # Set up Python virtual environment and dependencies
make start    # Launch the practice room at http://127.0.0.1:8765
```

---

### Alternative Installation Options

#### Using `uv` (Recommended)

```bash
uv tool install git+https://github.com/t10ko/russian-pyramid
russian-pyramid
```

#### Using `pipx`

```bash
pipx install git+https://github.com/t10ko/russian-pyramid
russian-pyramid
```

#### From Source

```bash
git clone git@github.com:t10ko/russian-pyramid.git
cd russian-pyramid
make setup
make start
```

#### macOS App Bundle

You can also build a native standalone `.app`:

```bash
packaging/build_macos.sh
```

---

## Controls & Keybindings

| Input | Action |
| :--- | :--- |
| **Drag** | Orbit camera around the followed ball |
| **Scroll Wheel** | Zoom camera in / out |
| **Click ball** | Follow that ball and make it the active cue ball |
| <kbd>C</kbd> | Move camera focus back to the cue ball |
| <kbd>Shift</kbd> + **Drag** | Aim the cue stick from the cue ball |
| <kbd>Shift</kbd> + **Wheel** | Adjust cue striking speed (power) |
| <kbd>Space</kbd> | Shoot |
| <kbd>R</kbd> / <kbd>U</kbd> | Repeat the exact pre-shot situation (undo) |
| <kbd>P</kbd> | Replay last shot |
| <kbd>←</kbd> <kbd>→</kbd> | Fine aim adjustment (±0.05°, with <kbd>Shift</kbd> = ±0.5°) |
| <kbd>↑</kbd> <kbd>↓</kbd> | Adjust cue power |
| <kbd>N</kbd> | New rack (15 white balls racked on the foot spot) |
| <kbd>M</kbd> | Toggle Aim ⇄ Place balls mode |
| **Drag ball** *(Place mode)* | Move ball position on table |
| **Click cloth** *(Place mode)* | Add a new ball |
| **Right-click ball** *(Place mode)* | Remove ball |
| **Double-click ball** *(Aim mode)* | Aim straight at that ball |
| <kbd>?</kbd> | Open help & controls overlay |

---

## Physics & Table Specification

Physics simulations are calculated server-side using [pooltool](https://github.com/ekiefl/pooltool) with parameters tailored to Russian Pyramid standards in [`src/russian_pyramid/config.py`](src/russian_pyramid/config.py):

| Parameter | Value | Details |
| :--- | :--- | :--- |
| **Table Surface** | 3.56 × 1.78 m | 12-ft tournament standard |
| **Corner Mouth** | 74 mm | Only ~3 mm clearance for a 68 mm ball |
| **Corner Jaws** | Straight, 1.5 mm radius | Sharp leather-wrapped brass corners |
| **Side Mouth** | 82 mm | Tight slot pocket entry |
| **Ball** | 68 mm, 285 g | Aramith Tournament Pyramid balls |
| **Cloth Sliding Friction** | `u_s = 0.20` | Standard high-grade worsted cloth |
| **Cloth Rolling Friction** | `u_r = 0.01` | Fast rolling cloth |
| **Ball-to-Ball Restitution** | `e_b = 0.95` | High elasticity phenolic resin |
| **Ball-to-Ball Friction** | `u_b = 0.05` | Generates realistic cut throw |

Presets:
- `--physics tournament` (default): Fast rail response standard in competitive pyramid.
- `--physics research`: Cushion damping matching deadened leather faces.

---

## Development

All standard workflows are conveniently available via `make`:

```bash
make setup     # Create virtualenv and install editable package + dev dependencies
make start     # Run the application (or pass ARGS="--drill rack --no-browser")
make test      # Run full pytest suite and headless UI smoke tests
make smoke     # Run headless canvas UI smoke tests in Node.js
make lint      # Check code formatting with ruff
make format    # Automatically format code with ruff
make clean     # Clean build artifacts and pycache
make help      # Show all available make targets
```

### Repository Structure

```
├── Makefile                    # Developer targets (make start, make setup, etc.)
├── assets/                     # Screenshots, previews, and icons
├── packaging/                  # PyInstaller spec and macOS app builder
├── scripts/                    # Setup script, headless smoke test, and asset tools
│   ├── setup.sh                # Environment preparation script
│   └── ui_smoke.mjs            # Headless UI smoke test
├── src/
│   └── russian_pyramid/
│       ├── cli.py              # CLI entry point (arg parsing, server startup)
│       ├── config.py           # Table dimensions, ball specs, physics presets
│       ├── drills.py           # Built-in practice layouts (rack, straight, cuts, svoyak)
│       ├── physics.py          # Pooltool physics solver integration
│       ├── server.py           # Lightweight HTTP server & JSON API
│       ├── session.py          # State tracking, undo/repeat, attempt history
│       └── static/             # Frontend UI (3D Three.js view, CSS, aim controls)
└── tests/                      # Pytest suite (physics, drills, session, API)
```

---

## License

[MIT License](LICENSE). Built with [pooltool](https://github.com/ekiefl/pooltool) and [three.js](https://threejs.org).
