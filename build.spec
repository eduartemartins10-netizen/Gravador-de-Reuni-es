# PyInstaller spec para empacotar o Gravador de Reuniao num .exe
# Build: pyinstaller build.spec
# Saida: dist/GravadorDeReunioes/GravadorDeReunioes.exe
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None
raiz = Path.cwd()

# Dependencias que PyInstaller nao detecta sozinhas
datas = []
binaries = []
hiddenimports = []

for pkg in ("faster_whisper", "ctranslate2", "soundcard", "sounddevice",
            "soundfile", "tokenizers", "huggingface_hub"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# faster_whisper chama modelos dinamicamente — garante sub-modulos
hiddenimports += collect_submodules("faster_whisper")

a = Analysis(
    ["interface.py"],
    pathex=[str(raiz)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # pyannote.audio puxa PyTorch (~2GB) — deixamos fora do build basico.
        # Usuario avancado pode instalar separado se quiser diarizacao.
        "pyannote",
        "torch",
        "torchaudio",
        "torchvision",
        "matplotlib",
        "pandas",
        "scipy",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="GravadorDeReunioes",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,        # sem janela de terminal preta
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="GravadorDeReunioes",
)
