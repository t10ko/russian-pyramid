# PyInstaller spec for the Russian Pyramid practice table (.app bundle).
#
# Build:  packaging/build_macos.sh
#
# Notes:
# - pooltool-billiards is imported lazily in cli.py, so it needs to be a
#   hidden import; its data files (default configs) are collected too.
# - numba/llvmlite ship native libs; PyInstaller's contributed hooks handle
#   them, they just make the bundle chunky (~300 MB uncompressed).

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

PROJECT_ROOT = Path(SPECPATH).resolve().parent  # noqa: F821  (SPECPATH is injected)
STATIC = PROJECT_ROOT / "src" / "russian_pyramid" / "static"

hiddenimports = [
    "russian_pyramid",
    "russian_pyramid.cli",
    "russian_pyramid.config",
    "russian_pyramid.physics",
    "russian_pyramid.drills",
    "russian_pyramid.session",
    "russian_pyramid.server",
    *collect_submodules("pooltool"),
]
datas = [
    (str(STATIC), "russian_pyramid/static"),
    *collect_data_files("pooltool"),
]

a = Analysis(
    [str(PROJECT_ROOT / "src" / "russian_pyramid" / "__main__.py")],
    pathex=[str(PROJECT_ROOT / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="russian-pyramid",
    debug=False,
    console=False,          # .app: no Terminal window; the browser is the UI
    argv_emulation=False,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="russian-pyramid",
)
app = BUNDLE(
    coll,
    name="Russian Pyramid.app",
    icon=str(PROJECT_ROOT / "assets" / "icon.icns") if (PROJECT_ROOT / "assets" / "icon.icns").exists() else None,
    info_plist={
        "CFBundleDisplayName": "Russian Pyramid",
        "CFBundleIdentifier": "com.tigranatayan.russian-pyramid",
        "CFBundleShortVersionString": "0.1.0",
        "CFBundleName": "Russian Pyramid",
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.games",
    },
)
