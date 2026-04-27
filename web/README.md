# Gravador de Reunião — Versão Web

Aplicação 100% no navegador. Sem servidor, sem instalação, sem backend.

## Para o usuário final

1. Abrir a URL (ex: `https://seudominio.com/`)
2. Na primeira vez, colar a chave gratuita do Google Gemini
3. Clicar **Iniciar Gravação**
4. O navegador pede:
   - Permissão de **microfone** (para capturar sua voz)
   - Permissão de **compartilhamento** (para capturar áudio do Meet/Teams/Zoom)
   - **IMPORTANTE**: na caixa do navegador, selecionar a **aba** da reunião e marcar **"Compartilhar áudio do sistema"** / **"Compartilhar áudio da aba"**
5. Ao terminar, clicar **Parar**. O áudio sobe pro Gemini, a ata é gerada, e você pode baixar em .md

## Como hospedar (grátis)

A pasta `web/` contém apenas arquivos estáticos. Qualquer hospedagem serve:

### GitHub Pages (mais fácil)
```bash
# No repositório do projeto:
# 1. Settings → Pages → Source: deploy from branch
# 2. Escolher branch "main" e pasta "/web"
# 3. Aguardar ~1min, acessar https://USUARIO.github.io/REPO/
```

### Netlify / Vercel (arrastar e soltar)
1. netlify.com/drop ou vercel.com/new
2. Arrastar a pasta `web/`
3. Pronto — URL pública gerada automaticamente

### Servidor local (para testar)
```bash
cd web
python -m http.server 8000
# Abrir http://localhost:8000
```

## Compatibilidade

| Funcionalidade | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| Captura de microfone | ✅ | ✅ | ✅ | ✅ |
| Captura de áudio do sistema | ✅ (Windows/Chrome OS) | ✅ | ❌ | ❌ (só tab audio) |
| Gravação | ✅ | ✅ | ✅ | ✅ |

**Recomendação**: Chrome ou Edge no Windows pra captura completa.

## Arquitetura

```
Browser
  ├─ navigator.mediaDevices.getUserMedia  → microfone
  ├─ navigator.mediaDevices.getDisplayMedia → áudio do sistema
  ├─ AudioContext mixa os dois streams
  ├─ MediaRecorder grava em WebM/Opus
  │
  └─ Ao parar:
       ├─ Áudio < 18 MB: inline_data base64
       │  Áudio ≥ 18 MB: upload via Gemini Files API
       └─ generateContent com prompt da ata
```

A chave da API fica em `localStorage` — nunca sai do navegador do usuário exceto para chamar a API do Gemini.

## Limitações

- **Safari / iOS**: captura de áudio do sistema não é suportada (só microfone e tab audio)
- **Firefox no Windows**: pode não capturar áudio do sistema em alguns cenários
- **Reuniões muito longas** (>2h): o blob fica grande (60-100 MB). Gemini aceita mas o upload demora

## Custos

- **Hosting**: grátis (GitHub Pages, Netlify, Vercel)
- **Gemini API**: gratuita até ~15 requests/min no tier free. Cada reunião = 1 request
