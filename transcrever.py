"""
ETAPA 2 - Transcricao de audio com faster-whisper.

Le o WAV em chunks com soundfile (sem carregar tudo na memoria)
e transcreve cada chunk separadamente — permite gravacoes longas.
"""
import sys
from unittest.mock import MagicMock

# Moca a biblioteca 'av' antes de importar faster_whisper (contorna
# o bloqueio do Windows App Control). Nao usamos 'av' — lemos via soundfile.
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
IDIOMA      = None      # None = auto-detecta por chunk (suporta PT + EN misturados)
PASTA_SAIDA = "transcricoes"

# ──────────────────────────────────────────────


def carregar_modelo(nome: str) -> WhisperModel:
    print(f"Carregando modelo '{nome}'...")
    print("(Na primeira vez, faz o download automatico — pode demorar)\n")
    modelo = WhisperModel(nome, device="cpu", compute_type="int8")
    print("Modelo carregado!\n")
    return modelo


def transcrever_arquivo(modelo: WhisperModel, caminho_wav: str,
                         idioma: str, diarizacao=None,
                         chunk_min: int = 10) -> str:
    """
    Transcreve um WAV longo lendo em chunks de 'chunk_min' minutos —
    permite reunioes de varias horas sem estourar memoria.

    Se 'diarizacao' for fornecida (lista de (inicio, fim, speaker)),
    cada trecho e rotulado com o falante correspondente.
    """
    from diarizar import atribuir_speaker

    info = sf.info(caminho_wav)
    frames_por_chunk = int(chunk_min * 60 * info.samplerate)
    total_min = info.frames / info.samplerate / 60
    print(f"Transcrevendo em chunks de {chunk_min}min "
          f"({total_min:.1f}min total)...\n")

    blocos = []
    speaker_atual = None
    texto_atual = []
    lang_atual = None

    def finalizar_bloco():
        if texto_atual:
            prefixo = f"[{speaker_atual}] " if speaker_atual else ""
            lang = f"[{lang_atual}] " if lang_atual else ""
            blocos.append(f"{prefixo}{lang}" + " ".join(texto_atual))

    with sf.SoundFile(caminho_wav) as f:
        indice = 0
        while f.tell() < info.frames:
            pos_frames = f.tell()
            offset_s = pos_frames / info.samplerate
            chunk = f.read(frames_por_chunk, dtype="float32")
            if chunk.ndim > 1:
                chunk = chunk.mean(axis=1)
            if info.samplerate != 16000:
                n = int(len(chunk) * 16000 / info.samplerate)
                chunk = np.interp(np.linspace(0, len(chunk), n),
                                  np.arange(len(chunk)), chunk).astype(np.float32)
            indice += 1
            print(f"  Chunk {indice}: transcrevendo...", flush=True)
            segs, info_chunk = modelo.transcribe(
                chunk,
                language=idioma,
                beam_size=5,
                vad_filter=False,
                no_speech_threshold=1.0,
                condition_on_previous_text=False,
            )
            lang = info_chunk.language if idioma is None else idioma

            for seg in segs:
                texto_seg = seg.text.strip()
                if not texto_seg:
                    continue
                speaker = None
                if diarizacao:
                    ts_ini = offset_s + seg.start
                    ts_fim = offset_s + seg.end
                    speaker = atribuir_speaker(ts_ini, ts_fim, diarizacao)

                # Agrupa segmentos consecutivos do mesmo falante e idioma
                if speaker != speaker_atual or lang != lang_atual:
                    finalizar_bloco()
                    speaker_atual = speaker
                    lang_atual = lang
                    texto_atual = []
                texto_atual.append(texto_seg)

    finalizar_bloco()
    return "\n".join(blocos).strip()


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


