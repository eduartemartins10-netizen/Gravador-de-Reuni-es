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
                "alto-falante", "speaker", "output"]
    preferir = ["intel", "tecnologia", "realtek", "mic input"]

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
        """Mostra o tempo decorrido enquanto grava."""
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
        input()  # Bloqueia ate o usuario apertar Enter
        parar.set()

    print()  # quebra de linha depois do contador

    # Junta todos os pedacos capturados
    while not fila.empty():
        pedacos.append(fila.get())

    if not pedacos:
        return np.zeros((0, CANAIS), dtype="float32")

    return np.concatenate(pedacos)


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
