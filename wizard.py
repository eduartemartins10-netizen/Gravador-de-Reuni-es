"""
Wizard de primeira execucao — pede a chave do Gemini se nao estiver configurada.
Inclui botao para abrir o site onde criar a chave (grátis).
"""
import tkinter as tk
from tkinter import messagebox
import webbrowser
import urllib.request
import urllib.error
import json

import config


URL_OBTER_CHAVE = "https://aistudio.google.com/apikey"


def _testar_chave(chave: str) -> tuple[bool, str]:
    """
    Faz uma chamada minima para validar a chave.
    Retorna (aceitar, mensagem) — aceitar eh True se a chave parece valida
    OU se o erro foi transiente (servidor ocupado).
    """
    # Validacao basica de formato
    if not chave.startswith("AIza") or len(chave) < 30:
        return False, "Formato invalido. Chaves Gemini comecam com 'AIza'."

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/gemini-2.5-flash:generateContent?key={chave}"
    )
    corpo = json.dumps({
        "contents": [{"parts": [{"text": "ping"}]}]
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=corpo,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
        return True, "Chave valida."
    except urllib.error.HTTPError as e:
        corpo_erro = e.read()
        if e.code in (400, 403) and (b"API_KEY_INVALID" in corpo_erro
                                       or b"API key not valid" in corpo_erro):
            return False, "Chave invalida. Verifique e tente novamente."
        if e.code in (429, 500, 502, 503, 504):
            # Erro transiente — aceita a chave, vai testar de verdade na hora da gravacao
            return True, "Servidor Gemini ocupado — chave salva, tente gravar."
        return False, f"Erro {e.code}. Tente novamente."
    except Exception as e:
        # Sem rede / timeout: aceita e deixa o usuario tentar depois
        return True, f"Sem validacao (sem rede?): {e}. Chave salva mesmo assim."


def abrir_wizard() -> bool:
    """
    Abre a janela do wizard. Retorna True se a chave foi configurada com sucesso,
    False se o usuario fechou sem configurar.
    """
    resultado = {"ok": False}

    janela = tk.Tk()
    janela.title("Configuracao — Gravador de Reuniao")
    janela.geometry("520x380")
    janela.resizable(False, False)
    janela.configure(bg="#1e1e1e")

    tk.Label(janela, text="Bem-vindo!",
             font=("Segoe UI", 16, "bold"),
             fg="#ffffff", bg="#1e1e1e").pack(pady=(20, 5))

    tk.Label(janela,
             text="Antes de usar, cole sua chave da API do Google Gemini.\n"
                  "E gratis — se nao tiver, clique no botao abaixo.",
             font=("Segoe UI", 10),
             fg="#aaaaaa", bg="#1e1e1e",
             justify="center").pack(pady=(0, 15))

    tk.Button(janela,
              text="Obter chave gratis (abre o navegador)",
              font=("Segoe UI", 10),
              fg="#ffffff", bg="#4285F4",
              activeforeground="#ffffff", activebackground="#5a95f5",
              relief="flat", cursor="hand2", padx=16, pady=6,
              command=lambda: webbrowser.open(URL_OBTER_CHAVE)).pack(pady=(0, 15))

    tk.Label(janela, text="Cole a chave aqui:",
             font=("Segoe UI", 10),
             fg="#ffffff", bg="#1e1e1e").pack(pady=(0, 4))

    entry = tk.Entry(janela, font=("Consolas", 11), width=50,
                     bg="#2d2d2d", fg="#ffffff", insertbackground="#ffffff",
                     relief="flat")
    entry.pack(ipady=6)
    entry.focus_set()

    status = tk.Label(janela, text="", font=("Segoe UI", 9),
                      fg="#aaaaaa", bg="#1e1e1e", wraplength=480)
    status.pack(pady=(10, 0))

    def salvar():
        chave = entry.get().strip()
        if not chave:
            status.config(text="Cole a chave antes de salvar.", fg="#ffaa44")
            return

        status.config(text="Validando a chave...", fg="#88ccff")
        janela.update()

        ok, msg = _testar_chave(chave)
        if ok:
            config.set_chave("GEMINI_API_KEY", chave)
            cor = "#88ff88" if msg.startswith("Chave valida") else "#ffcc66"
            status.config(text=msg, fg=cor)
            resultado["ok"] = True
            janela.after(1500, janela.destroy)
        else:
            status.config(text=msg, fg="#ff6b6b")

    botoes = tk.Frame(janela, bg="#1e1e1e")
    botoes.pack(pady=20)

    tk.Button(botoes, text="Salvar e continuar",
              font=("Segoe UI", 11, "bold"),
              fg="#ffffff", bg="#2e7d32",
              activeforeground="#ffffff", activebackground="#3e8d42",
              relief="flat", cursor="hand2", padx=20, pady=8,
              command=salvar).pack(side="left", padx=5)

    tk.Button(botoes, text="Fechar",
              font=("Segoe UI", 11),
              fg="#ffffff", bg="#555555",
              activeforeground="#ffffff", activebackground="#666666",
              relief="flat", cursor="hand2", padx=20, pady=8,
              command=janela.destroy).pack(side="left", padx=5)

    entry.bind("<Return>", lambda _: salvar())

    janela.mainloop()
    return resultado["ok"]


if __name__ == "__main__":
    abrir_wizard()
