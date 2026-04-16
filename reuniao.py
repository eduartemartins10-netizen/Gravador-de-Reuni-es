"""
ETAPA 4 - Fluxo automatizado completo.

Executa em sequencia:
  1. Gravacao do audio
  2. Transcricao
  3. Geracao da ata

Modos:
  python reuniao.py          → interativo: Enter para comecar, Enter para parar
  python reuniao.py 120      → grava automaticamente por 120 segundos
"""
import os
import sys

# IMPORTANTE: importar 'transcrever' ANTES de qualquer coisa que use
# faster_whisper — ele faz o mock de 'av' que o Windows bloqueia.
import transcrever
import gravar_audio
import gerar_ata


def banner(numero: int, titulo: str) -> None:
    print()
    print("=" * 60)
    print(f"  ETAPA {numero}/3 — {titulo}")
    print("=" * 60)


def etapa_gravar(duracao: int | None) -> str:
    banner(1, "GRAVACAO")

    if duracao is None:
        print("Pressione ENTER para comecar a gravar...")
        input()
        audio = gravar_audio.gravar_ate_enter()
    else:
        audio = gravar_audio.gravar_tempo_fixo(duracao)

    if len(audio) == 0:
        print("ERRO: nenhum audio foi capturado.")
        sys.exit(1)

    caminho = gravar_audio.salvar_audio(audio)
    duracao_gravada = len(audio) / gravar_audio.TAXA_AMOSTRAGEM
    tamanho_kb = os.path.getsize(caminho) / 1024
    print(f"\nAudio salvo: {caminho}")
    print(f"Duracao: {duracao_gravada:.1f}s | Tamanho: {tamanho_kb:.0f} KB")

    return caminho


def etapa_transcrever(caminho_audio: str) -> tuple[str, str]:
    banner(2, "TRANSCRICAO COM WHISPER")

    audio  = transcrever.carregar_audio(caminho_audio)
    modelo = transcrever.carregar_modelo(transcrever.MODELO)
    texto  = transcrever.transcrever(modelo, audio, transcrever.IDIOMA)

    caminho_txt = transcrever.salvar_transcricao(
        texto, caminho_audio, transcrever.PASTA_SAIDA
    )
    print(f"Transcricao salva: {caminho_txt}")
    print(f"\nPrevia ({len(texto)} caracteres):")
    print("-" * 60)
    print(texto[:300] + ("..." if len(texto) > 300 else ""))
    print("-" * 60)

    return texto, caminho_txt


def etapa_gerar_ata(texto: str, caminho_transcricao: str) -> str:
    banner(3, "GERACAO DA ATA COM GEMINI")

    if len(texto.strip()) < 30:
        print("Transcricao muito curta — pulando geracao da ata.")
        return ""

    ata = gerar_ata.gerar_ata(texto, gerar_ata.MODELO)
    caminho_ata = gerar_ata.salvar_ata(
        ata, caminho_transcricao, gerar_ata.PASTA_SAIDA
    )

    print(f"Ata salva: {caminho_ata}")
    print(f"\nPrevia da ata:")
    print("-" * 60)
    print(ata[:500] + ("..." if len(ata) > 500 else ""))
    print("-" * 60)

    return caminho_ata


def main():
    print("\n" + "=" * 60)
    print("  GRAVADOR DE REUNIAO — FLUXO COMPLETO")
    print("=" * 60)

    # Parse do argumento — se passar numero, grava por tempo fixo
    duracao = None
    if len(sys.argv) > 1:
        try:
            duracao = int(sys.argv[1])
        except ValueError:
            print(f"Argumento invalido: {sys.argv[1]} (deve ser um numero de segundos)")
            sys.exit(1)

    try:
        caminho_audio      = etapa_gravar(duracao)
        texto, caminho_txt = etapa_transcrever(caminho_audio)
        caminho_ata        = etapa_gerar_ata(texto, caminho_txt)
    except KeyboardInterrupt:
        print("\n\nFluxo interrompido pelo usuario.")
        sys.exit(0)
    except Exception as e:
        print(f"\nERRO durante o fluxo: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("  CONCLUIDO")
    print("=" * 60)
    print(f"  Audio:        {caminho_audio}")
    print(f"  Transcricao:  {caminho_txt}")
    if caminho_ata:
        print(f"  Ata:          {caminho_ata}")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
