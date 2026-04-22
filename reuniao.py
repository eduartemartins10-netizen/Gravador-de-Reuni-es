"""
Gravador de Reuniao — Fluxo completo.

Grava audio → transcreve com Whisper → gera ata com Gemini.

Modos:
  python reuniao.py          → interativo: Enter para comecar, Enter para parar
  python reuniao.py 120      → grava automaticamente por 120 segundos
"""
import os
import sys

# Garante que o diretorio de trabalho e o mesmo do script,
# independente de como o programa foi aberto (atalho, .bat, etc).
RAIZ = os.path.dirname(os.path.abspath(__file__))
os.chdir(RAIZ)

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


def verificar_requisitos() -> None:
    """Verifica se tudo esta configurado antes de comecar a gravar."""
    # 1. Chave da API do Gemini
    if not os.environ.get("GEMINI_API_KEY"):
        print("ERRO: Chave da API Gemini nao configurada.")
        print("Peca ao responsavel de TI para rodar o instalador.")
        input("\nPressione ENTER para fechar...")
        sys.exit(1)

    # 2. Microfone detectado
    if gravar_audio.DISPOSITIVO is None:
        print("ERRO: Nenhum microfone encontrado.")
        print("Verifique se o microfone esta conectado ao computador.")
        input("\nPressione ENTER para fechar...")
        sys.exit(1)

    print(f"  API Gemini:  OK")
    print(f"  Microfone:   OK")


def etapa_gravar(duracao: int | None) -> str:
    banner(1, "GRAVACAO")

    if duracao is None:
        # Modo interativo: streaming para disco (aguenta horas de gravacao)
        print("Pressione ENTER para comecar a gravar...")
        input()
        caminho, pico = gravar_audio.gravar_streaming(gravar_audio.PASTA_SAIDA)
    else:
        # Modo tempo fixo: mantido para testes curtos
        import numpy as np
        audio = gravar_audio.gravar_tempo_fixo(duracao)
        if len(audio) == 0:
            print("ERRO: nenhum audio foi capturado.")
            input("\nPressione ENTER para fechar...")
            sys.exit(1)
        pico = float(abs(audio).max())
        caminho = gravar_audio.salvar_audio(audio)

    if pico < 0.005:
        print(f"\nAVISO: o microfone captou muito pouco som (volume: {pico:.4f}).")
        print("Dica: fale mais perto do microfone ou verifique se nao esta no mudo.")

    tamanho_mb = os.path.getsize(caminho) / (1024 * 1024)
    print(f"\nAudio salvo: {caminho}")
    print(f"Tamanho: {tamanho_mb:.1f} MB")

    return caminho


def etapa_transcrever(caminho_audio: str) -> tuple[str, str]:
    banner(2, "TRANSCRICAO COM WHISPER")

    modelo = transcrever.carregar_modelo(transcrever.MODELO)

    # Usa sempre a versao em blocos — funciona para qualquer duracao
    texto  = transcrever.transcrever_arquivo_longo(
        caminho_audio, modelo, transcrever.IDIOMA,
    )

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
    print("  GRAVADOR DE REUNIAO")
    print("=" * 60)

    # 0. Verifica requisitos antes de comecar
    verificar_requisitos()

    # 1. Duracao
    duracao = None
    if len(sys.argv) > 1:
        try:
            duracao = int(sys.argv[1])
        except ValueError:
            print(f"Argumento invalido: {sys.argv[1]} (deve ser um numero de segundos)")
            input("\nPressione ENTER para fechar...")
            sys.exit(1)

    # 2. Executa as 3 etapas
    try:
        caminho_audio      = etapa_gravar(duracao)
        texto, caminho_txt = etapa_transcrever(caminho_audio)
        caminho_ata        = etapa_gerar_ata(texto, caminho_txt)
    except KeyboardInterrupt:
        print("\n\nGravacao interrompida.")
        input("\nPressione ENTER para fechar...")
        sys.exit(0)
    except Exception as e:
        print(f"\nERRO: {e}")
        print("Se o problema persistir, procure o responsavel de TI.")
        input("\nPressione ENTER para fechar...")
        sys.exit(1)

    # 3. Resumo final
    print("\n" + "=" * 60)
    print("  CONCLUIDO!")
    print("=" * 60)
    print(f"  Audio:        {caminho_audio}")
    print(f"  Transcricao:  {caminho_txt}")
    if caminho_ata:
        print(f"  Ata:          {caminho_ata}")
    print("=" * 60)

    # 4. Abre a ata automaticamente no editor padrao
    if caminho_ata and os.path.exists(caminho_ata):
        print("\nAbrindo a ata...")
        os.startfile(caminho_ata)

    input("\nPressione ENTER para fechar...")


if __name__ == "__main__":
    main()
