"""
ETAPA EXTRA - Diarizacao de falantes (quem falou quando).

Usa pyannote-audio com o modelo speaker-diarization-3.1.
Requer HF_TOKEN no ambiente (gratuito em huggingface.co).

Se HF_TOKEN ou pyannote nao estiver disponivel, o pipeline continua
sem identificacao de falantes.
"""
import os
from typing import List, Tuple


def disponivel() -> bool:
    """Retorna True se pyannote e HF_TOKEN estao configurados."""
    if not os.environ.get("HF_TOKEN"):
        return False
    try:
        import pyannote.audio  # noqa: F401
        return True
    except ImportError:
        return False


def diarizar(caminho_wav: str) -> List[Tuple[float, float, str]]:
    """
    Identifica quem falou quando. Retorna lista de (inicio, fim, speaker_id).
    Levanta RuntimeError se HF_TOKEN nao estiver configurado.
    """
    from pyannote.audio import Pipeline

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError(
            "HF_TOKEN nao configurado. Crie um token gratis em "
            "huggingface.co/settings/tokens e aceite os termos de "
            "pyannote/speaker-diarization-3.1 e pyannote/segmentation-3.0."
        )

    print("Carregando modelo de diarizacao (primeira vez demora — ~400MB)...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=token,
    )

    print("Identificando falantes...")
    diarization = pipeline(caminho_wav)

    segs: List[Tuple[float, float, str]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segs.append((turn.start, turn.end, speaker))
    return segs


def atribuir_speaker(ts_inicio: float, ts_fim: float,
                      segs_diarizacao: List[Tuple[float, float, str]]) -> str:
    """
    Dado um intervalo de tempo, retorna o speaker com maior overlap
    nos segmentos de diarizacao.
    """
    melhor_overlap = 0.0
    melhor_speaker = "SPEAKER_?"
    for d_inicio, d_fim, speaker in segs_diarizacao:
        overlap = min(ts_fim, d_fim) - max(ts_inicio, d_inicio)
        if overlap > melhor_overlap:
            melhor_overlap = overlap
            melhor_speaker = speaker
    return melhor_speaker
