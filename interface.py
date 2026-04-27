"""
Interface grafica do Gravador de Reunioes.
Janela com botao Iniciar/Parar + atalho global Ctrl+Shift+G.
"""
import os
import sys
import threading
from datetime import datetime
import tkinter as tk

RAIZ = os.path.dirname(os.path.abspath(__file__))
os.chdir(RAIZ)

# Carrega chaves salvas localmente para o os.environ antes dos imports pesados
import config
config.aplicar_no_ambiente()

# Se nao tem chave do Gemini, abre o wizard primeiro
if not config.get_chave("GEMINI_API_KEY"):
    import wizard
    if not wizard.abrir_wizard():
        sys.exit(0)
    config.aplicar_no_ambiente()

# Importar transcrever primeiro — faz o mock do 'av' antes do faster_whisper
import transcrever
import gravar_audio
import gerar_ata
import diarizar
import sounddevice as sd

import ctypes
from ctypes import wintypes

MOD_CONTROL  = 0x0002
MOD_SHIFT    = 0x0004
MOD_NOREPEAT = 0x4000
VK_G         = 0x47
WM_HOTKEY    = 0x0312

BG_IDLE     = "#1e1e1e"
BG_GRAVANDO = "#3d0000"
BG_PROC     = "#0d1b2e"
BG_PRONTO   = "#0d2e0d"
BRANCO      = "#ffffff"
DIMMED      = "#666666"


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Gravador de Reuniao")
        self.root.geometry("400x240")
        self.root.resizable(False, False)
        self.root.configure(bg=BG_IDLE)

        self._estado = "idle"
        self._parar = threading.Event()
        self._inicio: datetime | None = None
        self._bg_widgets: list[tk.Widget] = []

        self._build_ui()
        self._register_hotkey()
        self._tick()

    def _build_ui(self):
        self.lbl_status = tk.Label(
            self.root, text="Pronto para gravar",
            font=("Segoe UI", 14, "bold"), fg=BRANCO, bg=BG_IDLE
        )
        self.lbl_status.pack(pady=(28, 4))
        self._bg_widgets.append(self.lbl_status)

        self.lbl_sub = tk.Label(
            self.root, text="",
            font=("Segoe UI", 10), fg=DIMMED, bg=BG_IDLE
        )
        self.lbl_sub.pack(pady=(0, 16))
        self._bg_widgets.append(self.lbl_sub)

        self.btn = tk.Button(
            self.root, text="  Iniciar Gravacao",
            font=("Segoe UI", 12, "bold"),
            fg=BRANCO, bg="#b03030",
            activeforeground=BRANCO, activebackground="#d04040",
            relief="flat", cursor="hand2", padx=24, pady=10,
            command=self.toggle
        )
        self.btn.pack()

        foot = tk.Frame(self.root, bg=BG_IDLE)
        foot.pack(side="bottom", fill="x", pady=10, padx=14)
        self._bg_widgets.append(foot)

        hint = "Ctrl+Shift+G  iniciar/parar"
        self.lbl_hint = tk.Label(foot, text=hint, font=("Segoe UI", 8),
                                  fg=DIMMED, bg=BG_IDLE, anchor="w")
        self.lbl_hint.pack(side="left")
        self._bg_widgets.append(self.lbl_hint)

        mic = gravar_audio.DISPOSITIVO
        mic_txt = sd.query_devices()[mic]["name"][:32] if mic is not None else "sem microfone"
        self.lbl_mic = tk.Label(foot, text=f"mic: {mic_txt}", font=("Segoe UI", 8),
                                 fg=DIMMED, bg=BG_IDLE, anchor="e")
        self.lbl_mic.pack(side="right")
        self._bg_widgets.append(self.lbl_mic)

    def _register_hotkey(self):
        def _pump():
            ok = ctypes.windll.user32.RegisterHotKey(
                None, 1, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_G
            )
            if not ok:
                self._ui(lambda: self.lbl_hint.config(text="Ctrl+Shift+G: falhou (tente como admin)"))
                return
            msg = wintypes.MSG()
            while ctypes.windll.user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
                if msg.message == WM_HOTKEY:
                    self.root.after(0, self.toggle)
                ctypes.windll.user32.TranslateMessage(ctypes.byref(msg))
                ctypes.windll.user32.DispatchMessageW(ctypes.byref(msg))

        threading.Thread(target=_pump, daemon=True).start()

    def toggle(self):
        if self._estado in ("idle", "pronto"):
            self._iniciar()
        elif self._estado == "gravando":
            self._parar_gravacao()

    def _iniciar(self):
        if not os.environ.get("GEMINI_API_KEY"):
            self._status("  GEMINI_API_KEY nao configurada", "#ff8888")
            return
        if gravar_audio.DISPOSITIVO is None:
            self._status("  Nenhum microfone encontrado", "#ff8888")
            return

        self._estado = "gravando"
        self._parar.clear()
        self._inicio = datetime.now()
        self._set_bg(BG_GRAVANDO)
        self._status("  Gravando...", BRANCO)
        self.lbl_sub.config(text="00:00", fg="#ff8888")
        self.btn.config(text="  Parar", bg="#555555", activebackground="#666666")

        threading.Thread(target=self._pipeline, daemon=True).start()

    def _parar_gravacao(self):
        self._parar.set()
        self._estado = "processando"
        self._set_bg(BG_PROC)
        self._status("  Parando...", BRANCO)
        self.lbl_sub.config(text="")
        self.btn.config(text="Aguarde...", state="disabled", bg="#333333")

    def _pipeline(self):
        try:
            caminho_audio = self._gravar()
            if not caminho_audio or not os.path.exists(caminho_audio):
                self._ui(lambda: (self._status("  Falha ao gravar audio", "#ffaa44"),
                                   self._reset_idle()))
                return

            # Diarizacao opcional (quem falou quando)
            diarizacao = None
            if diarizar.disponivel():
                self._ui(lambda: self._status("  Identificando falantes...", "#ccaaff"))
                try:
                    diarizacao = diarizar.diarizar(caminho_audio)
                    print(f"  Diarizacao: {len(set(s for _,_,s in diarizacao))} falantes identificados")
                except Exception as e:
                    print(f"  Diarizacao falhou: {e}")

            self._ui(lambda: self._status("  Transcrevendo...", "#88ccff"))
            modelo      = transcrever.carregar_modelo(transcrever.MODELO)
            texto       = transcrever.transcrever_arquivo(
                modelo, caminho_audio, transcrever.IDIOMA, diarizacao=diarizacao
            )
            caminho_txt = transcrever.salvar_transcricao(
                texto, caminho_audio, transcrever.PASTA_SAIDA
            )

            self._ui(lambda: self._status("  Gerando ata...", "#88ffcc"))
            ata         = gerar_ata.gerar_ata(
                texto if texto.strip() else "(sem transcricao)", gerar_ata.MODELO
            )
            caminho_ata = gerar_ata.salvar_ata(ata, caminho_txt, gerar_ata.PASTA_SAIDA)

            self._ui(lambda c=caminho_ata: self._concluido(c))

        except Exception as e:
            msg = str(e)[:55]
            self._ui(lambda m=msg: (self._status(f"  {m}", "#ff6b6b"), self._reset_idle()))

    def _gravar(self) -> str | None:
        try:
            return gravar_audio.gravar_ate_evento(self._parar)
        except Exception:
            return None

    def _concluido(self, caminho_ata: str):
        self._estado = "pronto"
        self._set_bg(BG_PRONTO)
        self._status("  Ata gerada!", BRANCO)
        self.lbl_sub.config(text=os.path.basename(caminho_ata)[:48], fg="#88ff88")
        self.btn.config(text="  Nova Gravacao", state="normal",
                        bg="#b03030", activebackground="#d04040")
        os.startfile(caminho_ata)

    def _reset_idle(self):
        self._estado = "idle"
        self._set_bg(BG_IDLE)
        self.lbl_sub.config(text="")
        self.btn.config(text="  Iniciar Gravacao", state="normal",
                        bg="#b03030", activebackground="#d04040")

    def _tick(self):
        if self._estado == "gravando" and self._inicio:
            dec = (datetime.now() - self._inicio).total_seconds()
            m, s = int(dec // 60), int(dec % 60)
            self.lbl_sub.config(text=f"{m:02d}:{s:02d}", fg="#ff8888")
        self.root.after(1000, self._tick)

    def _status(self, txt: str, cor: str = BRANCO):
        self.lbl_status.config(text=txt, fg=cor)

    def _set_bg(self, cor: str):
        self.root.configure(bg=cor)
        for w in self._bg_widgets:
            w.configure(bg=cor)

    def _ui(self, fn):
        self.root.after(0, fn)


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
