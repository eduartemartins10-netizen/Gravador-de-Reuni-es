"""
ETAPA 1 - Gravacao de audio (microfone + loopback do sistema).

Exporta 'gravar_ate_evento(evento)' — consumida pelo interface.py.
Escreve direto em disco (memoria constante — aguenta gravacoes longas).
"""
import sounddevice as sd
import soundfile as sf
import numpy as np
import queue
import threading
import os
from datetime import datetime

try:
    import soundcard as sc
    SOUNDCARD_OK = True
except ImportError:
    SOUNDCARD_OK = False


# ──────────────────────────────────────────────
# CONFIGURACOES
# ──────────────────────────────────────────────

CANAIS      = 1       # 1 = mono (ideal para voz e Whisper)
PASTA_SAIDA = "gravacoes"
MAX_HORAS   = 10      # duracao maxima de gravacao contínua

# ──────────────────────────────────────────────


def encontrar_microfone() -> tuple[int | None, int]:
    """
    Encontra automaticamente o microfone real do computador,
    ignorando dispositivos virtuais (VB-Cable, etc).
    Retorna (indice_do_dispositivo, taxa_de_amostragem_nativa).
    """
    ignorar  = ["cable", "vb-audio", "virtual", "mixagem", "stereo mix",
                "alto-falante", "speaker", "output", "audiominiport"]
    preferir = ["intel", "tecnologia", "realtek", "mic input", "cirrus"]

    dispositivos = sd.query_devices()
    candidatos = []

    for i, d in enumerate(dispositivos):
        if d["max_input_channels"] == 0:
            continue

        nome = d["name"].lower()

        if any(p in nome for p in ignorar):
            continue

        prioridade = 0
        if "grupo de microfones" in nome and any(p in nome for p in preferir):
            prioridade += 20
        elif any(p in nome for p in preferir):
            prioridade += 5

        candidatos.append((prioridade, i, d["name"], int(d["default_samplerate"])))

    if not candidatos:
        return None, 44100

    candidatos.sort(reverse=True)
    escolhido = candidatos[0]
    print(f"  Microfone detectado: [{escolhido[1]}] {escolhido[2]} ({escolhido[3]}Hz)")
    return escolhido[1], escolhido[3]


DISPOSITIVO, TAXA_AMOSTRAGEM = encontrar_microfone()


def encontrar_saida() -> tuple[int | None, int]:
    """
    Encontra o dispositivo de saida WASAPI para loopback
    (captura o audio que esta tocando no computador).
    """
    ignorar = ["audiominiport", "mapeador", "driver", "prim"]
    dispositivos = sd.query_devices()
    candidatos = []
    for i, d in enumerate(dispositivos):
        if d["max_output_channels"] == 0 or d["max_input_channels"] > 0:
            continue
        nome = d["name"].lower()
        if any(p in nome for p in ignorar):
            continue
        candidatos.append((int(d["default_samplerate"]), i, d["name"]))
    if not candidatos:
        return None, 48000
    candidatos.sort(reverse=True)
    taxa, idx, nome = candidatos[0]
    print(f"  Saida (loopback):   [{idx}] {nome} ({taxa}Hz)")
    return idx, taxa


DISPOSITIVO_SAIDA, TAXA_SAIDA = encontrar_saida()


def _writer_thread(fila: queue.Queue, caminho: str, taxa: int, canais: int,
                    parar: threading.Event) -> None:
    """Drena a fila e escreve os chunks direto em WAV (memoria constante)."""
    with sf.SoundFile(caminho, mode="w", samplerate=taxa,
                      channels=canais, subtype="FLOAT") as arq:
        while not parar.is_set() or not fila.empty():
            try:
                chunk = fila.get(timeout=0.2)
                arq.write(chunk)
            except queue.Empty:
                continue


def _gravar_loopback_sc(caminho: str, taxa: int, parar: threading.Event) -> None:
    """
    Captura o audio do sistema (loopback) usando a biblioteca 'soundcard'
    e escreve direto em WAV. Roda em thread separada.
    """
    if not SOUNDCARD_OK:
        return
    # COM precisa ser inicializado em toda thread no Windows que usa WASAPI
    import ctypes
    try:
        ctypes.windll.ole32.CoInitialize(None)
    except Exception:
        pass

    try:
        speaker = sc.default_speaker()
        mic_lb  = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        chunk_frames = taxa // 10  # blocos de 100ms
        with mic_lb.recorder(samplerate=taxa, channels=2) as rec, \
             sf.SoundFile(caminho, mode="w", samplerate=taxa,
                          channels=2, subtype="FLOAT") as arq:
            while not parar.is_set():
                data = rec.record(numframes=chunk_frames)
                arq.write(data.astype(np.float32))
    except Exception as e:
        print(f"  (loopback falhou: {e})")
    finally:
        try:
            ctypes.windll.ole32.CoUninitialize()
        except Exception:
            pass


def _mixar_arquivos(caminho_mic: str, caminho_loop: str,
                     caminho_final: str, chunk_s: int = 5) -> None:
    """
    Le mic e loopback em chunks de 5s, reamostras para a maior taxa,
    mixa e grava o resultado — mantem memoria constante.
    """
    info_mic  = sf.info(caminho_mic)
    info_loop = sf.info(caminho_loop)
    taxa_alvo = max(info_mic.samplerate, info_loop.samplerate)

    def resample(a: np.ndarray, orig: int) -> np.ndarray:
        if orig == taxa_alvo or len(a) == 0:
            return a.astype(np.float32)
        n = int(len(a) * taxa_alvo / orig)
        return np.interp(np.linspace(0, len(a), n),
                         np.arange(len(a)), a).astype(np.float32)

    with sf.SoundFile(caminho_mic)  as mic_f, \
         sf.SoundFile(caminho_loop) as loop_f, \
         sf.SoundFile(caminho_final, mode="w", samplerate=taxa_alvo,
                      channels=1, subtype="FLOAT") as out:

        while True:
            m = mic_f.read(chunk_s * info_mic.samplerate,  dtype="float32")
            l = loop_f.read(chunk_s * info_loop.samplerate, dtype="float32")
            if len(m) == 0 and len(l) == 0:
                break
            if m.ndim > 1:
                m = m.mean(axis=1)
            if l.ndim > 1:
                l = l.mean(axis=1)
            m = resample(m, info_mic.samplerate)
            l = resample(l, info_loop.samplerate)
            tam = max(len(m), len(l))
            if len(m) < tam:
                m = np.pad(m, (0, tam - len(m)))
            if len(l) < tam:
                l = np.pad(l, (0, tam - len(l)))
            if tam == 0:
                continue
            out.write(np.clip(m * 0.6 + l * 0.4, -1.0, 1.0).astype(np.float32))


def gravar_ate_evento(evento_parar: threading.Event) -> str:
    """
    Grava microfone + audio do sistema (loopback) simultaneamente, escrevendo
    direto em arquivos WAV (memoria constante — suporta gravacoes longas).
    Para quando evento_parar for setado ou apos MAX_HORAS horas.
    Retorna o caminho do WAV final ja mixado.
    """
    os.makedirs(PASTA_SAIDA, exist_ok=True)
    agora = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    caminho_final = os.path.join(PASTA_SAIDA, f"reuniao_{agora}.wav")
    tmp_mic  = caminho_final + ".mic.tmp.wav"
    tmp_loop = caminho_final + ".loop.tmp.wav"

    fila_mic = queue.Queue()

    def cb_mic(indata, frames, time, status):
        fila_mic.put(indata.copy())

    parar_writers = threading.Event()

    t_mic = threading.Thread(
        target=_writer_thread,
        args=(fila_mic, tmp_mic, TAXA_AMOSTRAGEM, CANAIS, parar_writers),
        daemon=True,
    )
    t_mic.start()

    stream_mic = sd.InputStream(
        samplerate=TAXA_AMOSTRAGEM, channels=CANAIS,
        dtype="float32", device=DISPOSITIVO, callback=cb_mic,
    )

    parar_loopback = threading.Event()
    t_loop = None
    loopback_ativo = False
    if SOUNDCARD_OK:
        t_loop = threading.Thread(
            target=_gravar_loopback_sc,
            args=(tmp_loop, TAXA_SAIDA, parar_loopback),
            daemon=True,
        )
        t_loop.start()
        loopback_ativo = True

    with stream_mic:
        evento_parar.wait(timeout=MAX_HORAS * 3600)

    parar_writers.set()
    parar_loopback.set()
    t_mic.join(timeout=10)
    if t_loop:
        t_loop.join(timeout=10)

    if loopback_ativo and os.path.exists(tmp_loop) and os.path.getsize(tmp_loop) > 100:
        _mixar_arquivos(tmp_mic, tmp_loop, caminho_final)
        for tmp in (tmp_mic, tmp_loop):
            try:
                os.remove(tmp)
            except OSError:
                pass
    else:
        if os.path.exists(tmp_mic):
            os.replace(tmp_mic, caminho_final)

    return caminho_final


