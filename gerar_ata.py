"""
ETAPA 3 - Geracao de ata da reuniao com IA (Google Gemini).

Usa urllib (padrao do Python) para chamar a API REST do Gemini —
sem depender de bibliotecas que o Windows App Control bloqueia.

Como usar:
  python gerar_ata.py                                  <- usa a transcricao mais recente
  python gerar_ata.py transcricoes/minha_reuniao.txt
"""
import os
import sys
import json
import time
import urllib.request
import urllib.error
from datetime import datetime


# ──────────────────────────────────────────────
# CONFIGURACOES
# ──────────────────────────────────────────────

MODELO        = "gemini-2.5-flash"   # Gratuito e rapido
PASTA_ENTRADA = "transcricoes"
PASTA_SAIDA   = "atas"

# ──────────────────────────────────────────────


PROMPT_ATA = """Voce e um assistente especializado em criar atas profissionais de reunioes.

A seguir esta a TRANSCRICAO automatica de uma reuniao gerada por reconhecimento de voz.
Ela pode conter erros tipicos de transcricao: palavras trocadas por sons parecidos,
nomes proprios escritos errado, pontuacao incorreta, frases cortadas.

ANTES de gerar a ata, corrija mentalmente esses erros interpretando pelo contexto
(ex: "caixa daqui" provavelmente e "caixa d'aqui" ou outro termo do contexto).

Gere uma ATA DE REUNIAO em portugues brasileiro com a seguinte estrutura:

# ATA DA REUNIAO

## RESUMO EXECUTIVO
(2-3 paragrafos resumindo o que foi discutido, com linguagem clara e corrigida)

## TEMAS ABORDADOS
(Lista dos principais assuntos tratados)

## DECISOES TOMADAS
(Lista das decisoes — se nao houver, escreva "Nenhuma decisao formal registrada")

## ACOES E RESPONSAVEIS
(Lista de tarefas, quem e responsavel e prazo, se mencionado)
Formato: - [Responsavel] Acao (prazo: X)

## PONTOS DE ATENCAO
(Riscos, duvidas, pendencias importantes)

## PROXIMOS PASSOS
(O que vem a seguir)

REGRAS OBRIGATORIAS:
- Use linguagem profissional, formal e objetiva
- Corrija erros de transcricao pelo contexto, sem inventar informacoes novas
- Substitua qualquer palavra de baixo calao, ofensa ou linguagem obscena por linguagem neutra e profissional
- Mantenha nomes proprios como aparecem na transcricao
- Se algum item nao foi mencionado, escreva "Nao mencionado"

TRANSCRICAO:
---
{transcricao}
---

Gere a ata agora:"""


def carregar_transcricao(caminho: str) -> str:
    """Le o arquivo de transcricao e remove o cabecalho informativo."""
    with open(caminho, "r", encoding="utf-8") as f:
        conteudo = f.read()

    if "-" * 60 in conteudo:
        conteudo = conteudo.split("-" * 60)[-1]

    return conteudo.strip()


def chamar_gemini(api_key: str, modelo: str, prompt: str, max_tentativas: int = 4) -> str:
    """
    Chama a API REST do Gemini via HTTP e retorna o texto gerado.
    Tenta novamente automaticamente em caso de sobrecarga do servidor (503/429).
    """
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{modelo}:generateContent?key={api_key}"
    )

    corpo = json.dumps({
        "contents": [
            {"parts": [{"text": prompt}]}
        ]
    }).encode("utf-8")

    requisicao = urllib.request.Request(
        url,
        data=corpo,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    # Retry com backoff exponencial: 2s, 4s, 8s...
    for tentativa in range(1, max_tentativas + 1):
        try:
            with urllib.request.urlopen(requisicao, timeout=60) as resposta:
                dados = json.loads(resposta.read().decode("utf-8"))
            break  # Sucesso — sai do loop

        except urllib.error.HTTPError as e:
            # 503 (sobrecarga) e 429 (rate limit) — vale tentar de novo
            if e.code in (503, 429) and tentativa < max_tentativas:
                espera = 2 ** tentativa
                print(f"  Servidor ocupado (HTTP {e.code}). Tentando de novo em {espera}s... "
                      f"(tentativa {tentativa}/{max_tentativas})")
                time.sleep(espera)
                continue
            corpo_erro = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Erro HTTP {e.code}: {corpo_erro}") from e

        except urllib.error.URLError as e:
            raise RuntimeError(f"Erro de conexao: {e.reason}") from e

    # Extrai o texto da resposta da API
    try:
        return dados["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError) as e:
        raise RuntimeError(
            f"Resposta inesperada da API: {json.dumps(dados)[:500]}"
        ) from e


def gerar_ata(transcricao: str, modelo: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Variavel GEMINI_API_KEY nao encontrada.\n"
            "Configure com: setx GEMINI_API_KEY \"sua_chave\" e reabra o terminal."
        )

    prompt = PROMPT_ATA.format(transcricao=transcricao)

    print(f"Enviando para o Gemini ({modelo})...")
    print("Aguarde — pode levar alguns segundos.\n")

    return chamar_gemini(api_key, modelo, prompt)


def salvar_ata(ata: str, caminho_transcricao: str, pasta_saida: str) -> str:
    os.makedirs(pasta_saida, exist_ok=True)

    nome_base = os.path.splitext(os.path.basename(caminho_transcricao))[0]
    nome_base = nome_base.replace("_transcricao_", "_ata_")
    agora     = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    caminho   = os.path.join(pasta_saida, f"{nome_base}_{agora}.md")

    with open(caminho, "w", encoding="utf-8") as f:
        f.write(f"<!-- Ata gerada em {agora} a partir de {caminho_transcricao} -->\n\n")
        f.write(ata)
        f.write("\n")

    return caminho


def encontrar_transcricao_recente(pasta: str) -> str:
    if not os.path.exists(pasta):
        print(f"Pasta '{pasta}/' nao encontrada. Rode transcrever.py primeiro.")
        sys.exit(1)

    arquivos = [
        os.path.join(pasta, f)
        for f in os.listdir(pasta)
        if f.endswith(".txt")
    ]
    if not arquivos:
        print(f"Nenhuma transcricao em '{pasta}/'")
        sys.exit(1)

    return max(arquivos, key=os.path.getmtime)


def main():
    if len(sys.argv) > 1:
        caminho_transcricao = sys.argv[1]
    else:
        caminho_transcricao = encontrar_transcricao_recente(PASTA_ENTRADA)
        print(f"Transcricao mais recente: {caminho_transcricao}\n")

    if not os.path.exists(caminho_transcricao):
        print(f"Arquivo nao encontrado: {caminho_transcricao}")
        sys.exit(1)

    print("=" * 60)
    print("  GERACAO DE ATA — Etapa 3")
    print("=" * 60 + "\n")

    transcricao = carregar_transcricao(caminho_transcricao)
    print(f"Transcricao carregada ({len(transcricao)} caracteres)\n")

    if len(transcricao) < 30:
        print("AVISO: transcricao muito curta — a ata pode nao ter conteudo util.\n")

    ata = gerar_ata(transcricao, MODELO)

    print("ATA GERADA:")
    print("-" * 60)
    print(ata)
    print("-" * 60)

    caminho_saida = salvar_ata(ata, caminho_transcricao, PASTA_SAIDA)
    print(f"\nAta salva em: {caminho_saida}")
    print("\nPronto!")


if __name__ == "__main__":
    main()
