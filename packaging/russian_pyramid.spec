# PyInstaller spec for the Russian Pyramid practice table (.app bundle).
#
# Build:  packaging/build_macos.sh
#
# Notes:
# - pooltool-billiards is imported lazily by the physics module, so its
#   submodules and data files (including default configs) are collected.
# - numba/llvmlite ship native libs; PyInstaller's contributed hooks handle
#   them, they just make the bundle chunky (~300 MB uncompressed).

import platform
import subprocess
import sysconfig
from importlib.metadata import distributions, version
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

PROJECT_ROOT = Path(SPECPATH).resolve().parent  # noqa: F821  (SPECPATH is injected)
STATIC = PROJECT_ROOT / "src" / "russian_pyramid" / "static"
LAUNCHER = Path(workpath) / "Russian Pyramid"  # noqa: F821 (injected by PyInstaller)

subprocess.run([
    "xcrun", "swiftc", "-O", "-parse-as-library", "-target", f"{platform.machine()}-apple-macos12.0",
    "-module-cache-path", str(LAUNCHER.parent / "swift-cache"),
    str(PROJECT_ROOT / "packaging" / "RussianPyramidApp.swift"), "-o", str(LAUNCHER),
], check=True)

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
    (str(PROJECT_ROOT / "LICENSE"), "Licenses/Russian Pyramid"),
    *collect_data_files("pooltool"),
]
python_license = Path(sysconfig.get_path("stdlib")) / "LICENSE.txt"
if python_license.is_file():
    datas.append((str(python_license), "Licenses/Python"))
for dist in distributions():
    for file in dist.files or ():
        if (
            len(file.parts) > 1
            and file.parts[0].endswith(".dist-info")
            and file.parts[1].lower().startswith(("license", "licence", "notice", "copying"))
        ):
            destination = Path("Licenses", dist.name, *file.parts[1:-1])
            datas.append((str(dist.locate_file(file)), str(destination)))

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
    console=True,
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
    [(LAUNCHER.name, str(LAUNCHER), "EXECUTABLE")],
    coll,
    name="Russian Pyramid.app",
    icon=str(PROJECT_ROOT / "assets" / "icon.icns"),
    bundle_identifier="com.tigranatayan.russian-pyramid",
    version=version("russian-pyramid"),
    info_plist={
        "LSBackgroundOnly": False,
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.games",
    },
)
