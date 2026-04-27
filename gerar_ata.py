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
MODELOS_FALLBACK = [                 # tentados em ordem se o principal falhar
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
]
PASTA_ENTRADA = "transcricoes"
PASTA_SAIDA   = "atas"

# ──────────────────────────────────────────────


PROMPT_ATA = """Voce e um assistente especializado em criar atas profissionais de reunioes.

A seguir esta a TRANSCRICAO automatica de uma reuniao gerada por reconhecimento de voz.
Ela pode conter erros tipicos de transcricao: palavras trocadas por sons parecidos,
nomes proprios escritos errado, pontuacao incorreta, frases cortadas.

FORMATO DA TRANSCRICAO:
Cada linha pode comecar com:
  [SPEAKER_XX] — identificador do falante (se a diarizacao estiver ativa)
  [pt] / [en] / ... — idioma detectado pelo reconhecedor de voz

Exemplo:
  [SPEAKER_01] [pt] Oi pessoal, tudo bem?
  [SPEAKER_02] [en] Yes, we need to deploy by Friday.

IDIOMAS MISTURADOS:
Reuniao corporativa brasileira tipica mistura PT + termos tecnicos em EN:
- Interprete trechos [en] em contexto (ex: "dedláin" [pt] era "deadline" em EN)
- Preserve termos tecnicos e nomes de produtos em EN como sao usados originalmente
  (ex: "deploy", "deadline", "meeting", "stakeholder", "sprint", "bug", "feature")
- Nao traduza nomes proprios, produtos ou jargao da area

FALANTES:
- Se houver tags [SPEAKER_XX], use-as para atribuir falas na ata
  (ex: "SPEAKER_01 propos X; SPEAKER_02 concordou com Y")
- Se algum falante se apresentar na transcricao ("aqui e o Joao"), use o nome
  real no lugar do SPEAKER_XX ao longo da ata
- Se nao houver tags de falante, escreva a ata de forma neutra

ANTES de gerar a ata, corrija mentalmente os erros de transcricao e o idioma dos
termos tecnicos interpretando pelo contexto.

Gere uma ATA DE REUNIAO em portugues brasileiro com a seguinte estrutura:

# ATA DA REUNIAO

## RESUMO EXECUTIVO
(2-3 paragrafos resumindo o que foi discutido, com linguagem clara e corrigida,
preservando termos tecnicos em EN conforme usados na reuniao)

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
- Use linguagem profissional, formal e objetiva em portugues brasileiro
- Corrija erros de transcricao pelo contexto, sem inventar informacoes novas
- Reconheca e corrija termos tecnicos em EN que foram transcritos foneticamente em PT
- Preserve siglas, nomes de ferramentas e termos tecnicos no idioma original
- Substitua qualquer palavra de baixo calao, ofensa ou linguagem obscena por linguagem neutra e profissional
- Mantenha nomes proprios como aparecem na transcricao
- Se algum item nao foi mencionado, escreva "Nao mencionado"
- NAO inclua as tags [pt]/[en]/[SPEAKER_XX] na ata final (use os nomes reais ou descricoes)

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


def chamar_gemini(api_key: str, modelo: str, prompt: str,
                   max_tentativas: int = 6) -> str:
    """
    Chama a API REST do Gemini via HTTP e retorna o texto gerado.
    Retry com backoff exponencial em caso de sobrecarga do servidor (503/429).
    Levanta RuntimeError se nao conseguir — caller pode tentar outro modelo.
    """
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{modelo}:generateContent?key={api_key}"
    )
    corpo = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}]
    }).encode("utf-8")
    requisicao = urllib.request.Request(
        url, data=corpo,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    # Backoff exponencial: 3s, 6s, 12s, 24s, 48s (total ~90s)
    for tentativa in range(1, max_tentativas + 1):
        try:
            with urllib.request.urlopen(requisicao, timeout=180) as resposta:
                dados = json.loads(resposta.read().decode("utf-8"))
            break

        except urllib.error.HTTPError as e:
            if e.code in (503, 429, 500, 502, 504) and tentativa < max_tentativas:
                espera = min(3 * (2 ** (tentativa - 1)), 60)
                print(f"  Servidor ocupado (HTTP {e.code}). Aguardando {espera}s... "
                      f"(tentativa {tentativa}/{max_tentativas})")
                time.sleep(espera)
                continue
            corpo_erro = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Erro HTTP {e.code}: {corpo_erro}") from e

        except urllib.error.URLError as e:
            if tentativa < max_tentativas:
                espera = min(3 * (2 ** (tentativa - 1)), 60)
                print(f"  Conexao falhou ({e.reason}). Aguardando {espera}s...")
                time.sleep(espera)
                continue
            raise RuntimeError(f"Erro de conexao: {e.reason}") from e

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

    # Tenta o modelo principal e cai em fallbacks se todos os retries falharem
    candidatos = [modelo] + [m for m in MODELOS_FALLBACK if m != modelo]
    ultimo_erro = None
    for mod in candidatos:
        print(f"Enviando para o Gemini ({mod})...")
        try:
            return chamar_gemini(api_key, mod, prompt)
        except RuntimeError as e:
            ultimo_erro = e
            msg = str(e)[:120]
            print(f"  Falhou: {msg}")
            print(f"  Tentando proximo modelo...\n")

    raise RuntimeError(f"Todos os modelos falharam. Ultimo erro: {ultimo_erro}")


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
