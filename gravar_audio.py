"""
ETAPA 1 - Gravacao de audio do microfone.

Suporta dois modos:
  - Duracao fixa: passa o numero de segundos
  - Ate apertar Enter: duracao indefinida (modo interativo)

Como usar (standalone):
  python gravar_audio.py
"""
import sounddevice as sd
import soundfile as sf
import numpy as np
import queue
import threading
import os
from datetime import datetime


# ──────────────────────────────────────────────
# CONFIGURACOES
# ──────────────────────────────────────────────

CANAIS      = 1       # 1 = mono (ideal para voz e Whisper)
PASTA_SAIDA = "gravacoes"

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


def _misturar(mic: np.ndarray, taxa_mic: int,
               loopback: np.ndarray, taxa_loop: int) -> np.ndarray:
    """Reamostras ambos para a maior taxa e mixa mic + loopback."""
    taxa_alvo = max(taxa_mic, taxa_loop)

    def resample(a: np.ndarray, orig: int) -> np.ndarray:
        if orig == taxa_alvo or len(a) == 0:
            return a
        n = int(len(a) * taxa_alvo / orig)
        return np.interp(np.linspace(0, len(a), n),
                         np.arange(len(a)), a).astype(np.float32)

    m = resample(mic.flatten(),      taxa_mic)
    l = resample(loopback.flatten(), taxa_loop)
    n = min(len(m), len(l))
    if n == 0:
        return m if len(m) > 0 else l
    return np.clip(m[:n] * 0.6 + l[:n] * 0.4, -1.0, 1.0)


def gravar_ate_evento(evento_parar: threading.Event) -> np.ndarray:
    """
    Grava microfone + audio do sistema (loopback) simultaneamente
    ate evento_parar ser setado ou 30 minutos se passarem.
    Retorna o audio mixado pronto para salvar.
    """
    fila_mic  = queue.Queue()
    fila_loop = queue.Queue()

    def cb_mic(indata, frames, time, status):
        fila_mic.put(indata.copy())

    def cb_loop(indata, frames, time, status):
        fila_loop.put(indata.copy())

    stream_mic = sd.InputStream(
        samplerate=TAXA_AMOSTRAGEM, channels=CANAIS,
        dtype="float32", device=DISPOSITIVO, callback=cb_mic,
    )

    stream_loop = None
    loopback_ativo = False
    if DISPOSITIVO_SAIDA is not None:
        try:
            stream_loop = sd.InputStream(
                samplerate=TAXA_SAIDA, channels=2,
                dtype="float32", device=DISPOSITIVO_SAIDA,
                extra_settings=sd.WasapiSettings(loopback=True),
                callback=cb_loop,
            )
            loopback_ativo = True
        except Exception as e:
            print(f"  (loopback indisponivel: {e})")

    with stream_mic:
        if stream_loop:
            with stream_loop:
                evento_parar.wait(timeout=30 * 60)
        else:
            evento_parar.wait(timeout=30 * 60)

    pedacos_mic = []
    while not fila_mic.empty():
        pedacos_mic.append(fila_mic.get())
    audio_mic = np.concatenate(pedacos_mic) if pedacos_mic else np.zeros((0,), dtype="float32")
    if audio_mic.ndim > 1:
        audio_mic = audio_mic.mean(axis=1)

    if not loopback_ativo:
        return audio_mic

    pedacos_loop = []
    while not fila_loop.empty():
        pedacos_loop.append(fila_loop.get())
    if not pedacos_loop:
        return audio_mic
    audio_loop = np.concatenate(pedacos_loop)
    if audio_loop.ndim > 1:
        audio_loop = audio_loop.mean(axis=1)

    return _misturar(audio_mic, TAXA_AMOSTRAGEM, audio_loop, TAXA_SAIDA)


def gravar_tempo_fixo(duracao: int, taxa: int = TAXA_AMOSTRAGEM) -> np.ndarray:
    """Grava por um numero fixo de segundos."""
    print(f"Gravando por {duracao} segundos...\n")
    audio = sd.rec(
        frames=int(duracao * taxa),
        samplerate=taxa,
        channels=CANAIS,
        dtype="float32",
        device=DISPOSITIVO,
    )
    sd.wait()
    return audio


def gravar_ate_enter(taxa: int = TAXA_AMOSTRAGEM) -> np.ndarray:
    """
    Grava em streaming ate o usuario pressionar Enter.
    Retorna o audio gravado como array numpy.

    ATENCAO: esta funcao acumula na RAM — use gravar_streaming()
    para gravacoes longas (mais de 30 minutos).
    """
    fila = queue.Queue()
    parar = threading.Event()

    def callback(indata, frames, time, status):
        if status:
            print(f"  (aviso: {status})")
        fila.put(indata.copy())

    stream = sd.InputStream(
        samplerate=taxa,
        channels=CANAIS,
        dtype="float32",
        device=DISPOSITIVO,
        callback=callback,
    )

    pedacos = []
    inicio = datetime.now()

    def atualizar_tempo():
        while not parar.is_set():
            decorrido = (datetime.now() - inicio).total_seconds()
            minutos = int(decorrido // 60)
            segundos = int(decorrido % 60)
            print(f"\r  Gravando: {minutos:02d}:{segundos:02d} — pressione ENTER para parar",
                  end="", flush=True)
            parar.wait(timeout=1)

    thread_tempo = threading.Thread(target=atualizar_tempo, daemon=True)

    with stream:
        thread_tempo.start()
        input()
        parar.set()

    print()

    while not fila.empty():
        pedacos.append(fila.get())

    if not pedacos:
        return np.zeros((0, CANAIS), dtype="float32")

    return np.concatenate(pedacos)


def gravar_streaming(pasta: str = PASTA_SAIDA,
                     taxa: int = TAXA_AMOSTRAGEM) -> tuple[str, float]:
    """
    Grava em streaming escrevendo direto no disco — uso de RAM constante.
    Funciona para gravacoes de qualquer duracao (minutos ou horas).

    Retorna (caminho_do_arquivo, volume_pico_medido).
    """
    os.makedirs(pasta, exist_ok=True)
    agora   = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    caminho = os.path.join(pasta, f"reuniao_{agora}.wav")

    parar = threading.Event()
    pico = [0.0]  # lista de 1 elemento para poder ser mutado dentro do callback

    # PCM_16: metade do tamanho de float32, mesma qualidade para voz
    arquivo = sf.SoundFile(caminho, mode="w", samplerate=taxa,
                            channels=CANAIS, subtype="PCM_16")

    def callback(indata, frames, time_info, status):
        arquivo.write(indata)
        p = float(abs(indata).max())
        if p > pico[0]:
            pico[0] = p

    stream = sd.InputStream(
        samplerate=taxa,
        channels=CANAIS,
        dtype="float32",
        device=DISPOSITIVO,
        callback=callback,
    )

    inicio = datetime.now()

    def atualizar_tempo():
        while not parar.is_set():
            decorrido = (datetime.now() - inicio).total_seconds()
            horas    = int(decorrido // 3600)
            minutos  = int((decorrido % 3600) // 60)
            segundos = int(decorrido % 60)
            print(f"\r  Gravando: {horas:02d}:{minutos:02d}:{segundos:02d} — pressione ENTER para parar",
                  end="", flush=True)
            parar.wait(timeout=1)

    thread_tempo = threading.Thread(target=atualizar_tempo, daemon=True)

    try:
        with stream:
            thread_tempo.start()
            input()
            parar.set()
    finally:
        arquivo.close()

    print()
    return caminho, pico[0]


def salvar_audio(audio: np.ndarray, taxa: int = TAXA_AMOSTRAGEM,
                 pasta: str = PASTA_SAIDA) -> str:
    """Salva o array de audio como .wav na pasta indicada. Retorna o caminho."""
    os.makedirs(pasta, exist_ok=True)
    agora   = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    caminho = os.path.join(pasta, f"reuniao_{agora}.wav")
    sf.write(caminho, audio, taxa)
    return caminho


def main():
    print("=" * 50)
    print("  GRAVADOR DE AUDIO — microfone")
    print("=" * 50)
    print()
    print("Pressione ENTER para comecar a gravar...")
    input()

    audio = gravar_ate_enter()

    caminho = salvar_audio(audio)
    duracao = len(audio) / TAXA_AMOSTRAGEM
    tamanho_kb = os.path.getsize(caminho) / 1024

    print(f"\nGravacao concluida:")
    print(f"  Duracao: {duracao:.1f}s")
    print(f"  Tamanho: {tamanho_kb:.0f} KB")
    print(f"  Arquivo: {caminho}")


if __name__ == "__main__":
    main()
