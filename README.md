# Gravador de Reuniao

Grava reunioes online (Meet, Teams, Zoom, WhatsApp, etc.), transcreve automaticamente e gera uma ata profissional com IA (Gemini).

## Duas versoes

| | Desktop (Windows) | Web (qualquer navegador) |
|---|---|---|
| Instalacao | Baixa ZIP, extrai, executa | So abrir a URL |
| Sistema operacional | So Windows | Windows / Mac / Linux |
| Transcricao | Whisper local | Gemini na nuvem |
| Identificacao de falantes | ✅ (opcional, via pyannote) | Basica (pelo contexto) |
| Loopback de audio do sistema | ✅ | ✅ (Windows) |
| Funciona offline | ✅ (a gravacao; a ata precisa de internet) | ❌ |
| Como distribuir | ZIP de 104 MB | URL publica (GitHub Pages grátis) |

Veja [`web/README.md`](web/README.md) para a versao web.

## Para usar (usuario final)

1. Baixe o arquivo **`GravadorDeReunioes.zip`** em [Releases](https://github.com/eduartemartins10-netizen/Gravador-de-Reuni-es/releases)
2. Extraia o ZIP em qualquer pasta (ex: `C:\GravadorDeReunioes`)
3. Execute **`GravadorDeReunioes.exe`**
4. Na primeira vez, o programa pede uma chave gratis da API do Google Gemini — clique no botao "Obter chave gratis" e siga as instrucoes
5. Clique em **Iniciar Gravacao** e comece sua reuniao — o resto e automatico!

Nao precisa instalar Python, nem configurar nada. Tudo ja esta dentro do ZIP.

## Funcionalidades

- Captura **mic + audio do sistema** (voz dos outros participantes em qualquer programa)
- Aguenta reunioes de **ate 10 horas**
- Transcricao **multilingue** (PT + termos tecnicos em EN)
- Atalho global `Ctrl+Shift+G` pra iniciar/parar sem clicar na janela
- Ata gerada automaticamente com resumo, decisoes, acoes e responsaveis

## Para desenvolvedores

Pre-requisitos:
- Python 3.13+
- Windows 10/11

```bash
git clone https://github.com/eduartemartins10-netizen/Gravador-de-Reuni-es
cd Gravador-de-Reuni-es
pip install -r requirements.txt
python interface.py
```

Para gerar o executavel:
```bash
pip install pyinstaller
pyinstaller build.spec
# Saida: dist/GravadorDeReunioes/GravadorDeReunioes.exe
```

## Tecnologias

- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** — transcricao local
- **[soundcard](https://github.com/bastibe/SoundCard)** — loopback WASAPI (captura audio do sistema)
- **[Google Gemini](https://ai.google.dev/)** — geracao da ata
- **[pyannote.audio](https://github.com/pyannote/pyannote-audio)** — identificacao de falantes (opcional)
