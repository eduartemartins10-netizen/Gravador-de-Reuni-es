"""
ETAPA 2 - Transcricao de audio com faster-whisper.

Lê o WAV com soundfile (sem DLL externa) e passa diretamente
como numpy array ao modelo — contornando o bloqueio do Windows
na biblioteca 'av'.

Como usar:
  python transcrever.py                          <- usa o .wav mais recente
  python transcrever.py gravacoes/minha_reuniao.wav
"""
import sys
from unittest.mock import MagicMock

# Moca a biblioteca 'av' antes de importar faster_whisper.
# Isso evita o ImportError causado pela politica de seguranca do Windows.
# Nao usaremos 'av' de qualquer forma — leremos o audio com soundfile.
sys.modules["av"] = MagicMock()

from faster_whisper import WhisperModel
import soundfile as sf
import numpy as np
import os
from datetime import datetime


# ──────────────────────────────────────────────
# CONFIGURACOES
# ──────────────────────────────────────────────

MODELO      = "medium"  # tiny | base | small | medium | large (medium = melhor para reunioes)
IDIOMA      = "pt"      # "pt" = portugues | "en" = ingles | None = auto
PASTA_SAIDA = "transcricoes"

# ──────────────────────────────────────────────


def carregar_audio(caminho: str) -> np.ndarray:
    """
    Le o arquivo WAV com soundfile e converte para
    float32 mono 16kHz — formato exigido pelo Whisper.

    ATENCAO: carrega tudo na memoria — nao use para arquivos de 1h+.
    Para arquivos longos, use transcrever_arquivo_longo().
    """
    audio, taxa_original = sf.read(caminho, dtype="float32")

    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    if taxa_original != 16000:
        n_amostras = int(len(audio) * 16000 / taxa_original)
        audio = np.interp(
            np.linspace(0, len(audio), n_amostras),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)

    return audio


def _bloco_para_whisper(bloco: np.ndarray, taxa_original: int) -> np.ndarray:
    """Converte um bloco de audio para o formato que o Whisper espera."""
    if bloco.ndim > 1:
        bloco = bloco.mean(axis=1)
    if taxa_original != 16000:
        n = int(len(bloco) * 16000 / taxa_original)
        bloco = np.interp(
            np.linspace(0, len(bloco), n),
            np.arange(len(bloco)),
            bloco,
        ).astype(np.float32)
    return bloco


def transcrever_arquivo_longo(caminho_audio: str, modelo: WhisperModel,
                              idioma: str, bloco_minutos: int = 10) -> str:
    """
    Transcreve um arquivo de audio lendo e processando em blocos,
    sem carregar tudo na RAM. Funciona para arquivos de qualquer duracao.
    """
    info = sf.info(caminho_audio)
    taxa = info.samplerate
    total_amostras = info.frames
    duracao_total = total_amostras / taxa

    bloco_amostras = int(bloco_minutos * 60 * taxa)
    total_blocos = (total_amostras + bloco_amostras - 1) // bloco_amostras

    print(f"Audio: {duracao_total / 60:.1f} minutos, processando em {total_blocos} bloco(s) de {bloco_minutos} min\n")

    textos = []
    with sf.SoundFile(caminho_audio, "r") as f:
        for num in range(1, total_blocos + 1):
            print(f"  Bloco {num}/{total_blocos}...", flush=True)
            bloco = f.read(bloco_amostras, dtype="float32")
            if len(bloco) == 0:
                break

            audio_whisper = _bloco_para_whisper(bloco, taxa)
            segmentos, info_t = modelo.transcribe(
                audio_whisper, language=idioma, beam_size=5,
            )
            texto = "".join(seg.text for seg in segmentos).strip()
            if texto:
                textos.append(texto)

    return " ".join(textos)


def carregar_modelo(nome: str) -> WhisperModel:
    print(f"Carregando modelo '{nome}'...")
    print("(Na primeira vez, faz o download automatico — pode demorar)\n")
    modelo = WhisperModel(nome, device="cpu", compute_type="int8")
    print("Modelo carregado!\n")
    return modelo


def transcrever(modelo: WhisperModel, audio: np.ndarray, idioma: str) -> str:
    print("Transcrevendo... Aguarde.\n")

    segmentos, info = modelo.transcribe(
        audio,
        language=idioma,
        beam_size=5,
    )

    print(f"Idioma: {info.language} (confianca: {info.language_probability:.0%})\n")

    return "".join(seg.text for seg in segmentos).strip()


def salvar_transcricao(texto: str, caminho_audio: str, pasta_saida: str) -> str:
    os.makedirs(pasta_saida, exist_ok=True)

    nome_base = os.path.splitext(os.path.basename(caminho_audio))[0]
    agora     = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    caminho   = os.path.join(pasta_saida, f"{nome_base}_transcricao_{agora}.txt")

    with open(caminho, "w", encoding="utf-8") as f:
        f.write("=" * 60 + "\n")
        f.write("TRANSCRICAO DE REUNIAO\n")
        f.write("=" * 60 + "\n\n")
        f.write(f"Arquivo: {caminho_audio}\n")
        f.write(f"Data:    {agora}\n\n")
        f.write("-" * 60 + "\n\n")
        f.write(texto + "\n")

    return caminho


def main():
    if len(sys.argv) > 1:
        caminho_audio = sys.argv[1]
    else:
        pasta = "gravacoes"
        if not os.path.exists(pasta):
            print("Pasta 'gravacoes/' nao encontrada. Rode gravar_audio.py primeiro.")
            sys.exit(1)
        arquivos = [
            os.path.join(pasta, f)
            for f in os.listdir(pasta)
            if f.endswith(".wav")
        ]
        if not arquivos:
            print("Nenhum arquivo .wav em 'gravacoes/'")
            sys.exit(1)
        caminho_audio = max(arquivos, key=os.path.getmtime)
        print(f"Arquivo mais recente: {caminho_audio}\n")

    if not os.path.exists(caminho_audio):
        print(f"Arquivo nao encontrado: {caminho_audio}")
        sys.exit(1)

    print("=" * 60)
    print("  TRANSCRICAO DE REUNIAO — Etapa 2")
    print("=" * 60 + "\n")

    audio  = carregar_audio(caminho_audio)
    modelo = carregar_modelo(MODELO)
    texto  = transcrever(modelo, audio, IDIOMA)

    print("RESULTADO:")
    print("-" * 60)
    print(texto)
    print("-" * 60)

    saida = salvar_transcricao(texto, caminho_audio, PASTA_SAIDA)
    print(f"\nSalvo em: {saida}")
    print("\nPronto!")


if __name__ == "__main__":
    main()
