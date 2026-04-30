/**
 * offscreen.js — roda em uma pagina invisivel mantida pela extensao.
 *
 * Responsabilidades:
 *  - Receber o streamId da aba do Meet (vem do background)
 *  - Gravar o audio com MediaRecorder
 *  - Quando parar, enviar o audio para a API do Gemini
 *  - Receber a ata em streaming e baixar o .md final
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODELO_GEMINI = "gemini-2.5-flash";
const MODELOS_FALLBACK = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
const LIMITE_INLINE = 18 * 1024 * 1024;

const PROMPT_ATA = `Voce e um assistente especializado em atas profissionais de reunioes.
Abaixo esta a gravacao em audio de uma reuniao corporativa em portugues brasileiro.

Gere a resposta no formato exato abaixo, em duas partes:

# TRANSCRICAO
(Transcricao corrigida pelo contexto, com pontuacao adequada.
Identifique falantes diferentes como "Participante A:", "Participante B:" etc.,
ou pelo nome real se alguem se apresentar.
Preserve termos tecnicos em ingles - deploy, deadline, sprint, bug, etc.)

---

# ATA DA REUNIAO

## RESUMO EXECUTIVO
(2-3 paragrafos)

## TEMAS ABORDADOS
(Lista)

## DECISOES TOMADAS
(Lista. Se nenhuma, "Nenhuma decisao formal registrada")

## ACOES E RESPONSAVEIS
(- [Responsavel] Acao (prazo: X))

## PONTOS DE ATENCAO

## PROXIMOS PASSOS

REGRAS:
- Linguagem profissional e objetiva
- Substitua palavras de baixo calao por linguagem neutra
- Se o audio for silencioso ou incompleto, diga "Audio sem conteudo suficiente para ata"
`;

// === Estado ===
let mediaRecorder = null;
let chunks = [];
let mediaStream = null;
let mimeTypeAtual = "audio/webm";

// === Mensagens do background ===
chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg.alvo !== "offscreen") return false;

  switch (msg.tipo) {
    case "iniciar":
      iniciarGravacao(msg.streamId)
        .then(() => responder({ ok: true }))
        .catch((e) => responder({ ok: false, erro: e.message }));
      return true;

    case "parar":
      pararGravacao()
        .then(() => responder({ ok: true }))
        .catch((e) => responder({ ok: false, erro: e.message }));
      return true;

    case "status":
      responder({
        ativo: Boolean(mediaRecorder) && mediaRecorder.state === "recording",
      });
      return false;
  }
});

// === Captura ===
async function iniciarGravacao(streamId) {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    throw new Error("Gravacao ja em andamento");
  }

  // Captura o audio da aba do Meet usando o streamId que veio do background.
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  // CRITICO: a captura corta o som da aba para o usuario.
  // Reprouvimos o audio na propria pagina offscreen para o som continuar saindo.
  const ctx = new AudioContext();
  const fonte = ctx.createMediaStreamSource(mediaStream);
  fonte.connect(ctx.destination);

  // Decide o melhor formato suportado
  const tiposSuportados = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  mimeTypeAtual = tiposSuportados.find(t => MediaRecorder.isTypeSupported(t)) || "audio/webm";

  chunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mimeTypeAtual });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mimeTypeAtual });
    chunks = [];
    avisarBackground("processando", { tamanho: blob.size });

    try {
      const ata = await processarComGemini(blob);
      await baixarAta(ata);
      avisarBackground("concluido", { ata });
    } catch (e) {
      console.error("Falha no processamento:", e);
      avisarBackground("erro", { mensagem: e.message });
    }

    // Encerra a pagina offscreen — a extensao recria quando precisar de novo
    setTimeout(() => window.close(), 1000);
  };

  mediaRecorder.start(1000);  // chunks a cada 1s
  avisarBackground("gravando");
}

async function pararGravacao() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    throw new Error("Nada para parar");
  }
  mediaRecorder.stop();

  // Para o stream para liberar o tab
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

function avisarBackground(estado, dados = {}) {
  chrome.runtime.sendMessage({
    alvo: "background",
    tipo: "estado-gravacao",
    estado,
    ...dados,
  });
}

// === Pipeline com Gemini ===
async function processarComGemini(blob) {
  const { gemini_api_key } = await chrome.storage.sync.get("gemini_api_key");
  if (!gemini_api_key) {
    throw new Error("Chave da API nao configurada");
  }

  let partAudio;
  if (blob.size < LIMITE_INLINE) {
    const base64 = await blobParaBase64(blob);
    partAudio = {
      inline_data: { mime_type: blob.type || "audio/webm", data: base64 },
    };
  } else {
    avisarBackground("subindo");
    const fileUri = await uploadArquivo(gemini_api_key, blob);
    partAudio = {
      file_data: { mime_type: blob.type || "audio/webm", file_uri: fileUri },
    };
  }

  const parts = [{ text: PROMPT_ATA }, partAudio];

  // Tenta os modelos em ordem com retry
  let ultimoErro = null;
  for (const modelo of MODELOS_FALLBACK) {
    for (let tentativa = 1; tentativa <= 4; tentativa++) {
      try {
        return await chamarGemini(gemini_api_key, modelo, parts);
      } catch (e) {
        ultimoErro = e;
        const transiente = [429, 500, 502, 503, 504].includes(e.status);
        if (!transiente) break;
        await new Promise(r => setTimeout(r, Math.min(3000 * 2 ** (tentativa - 1), 30000)));
      }
    }
  }
  throw ultimoErro || new Error("Todos os modelos falharam");
}

async function chamarGemini(chave, modelo, parts) {
  const resp = await fetch(
    `${BASE_URL}/models/${modelo}:generateContent?key=${chave}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  if (!resp.ok) {
    const txt = await resp.text();
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(txt);
      if (j.error?.message) msg = j.error.message;
    } catch {}
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  const j = await resp.json();
  const texto = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error("Resposta vazia da API");
  return texto.trim();
}

async function uploadArquivo(chave, blob) {
  const tamanho = blob.size;
  const mime = blob.type || "audio/webm";
  const nome = `reuniao_${Date.now()}`;

  const iniciaResp = await fetch(`${BASE_URL}/files?key=${chave}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command":  "start",
      "X-Goog-Upload-Header-Content-Length": tamanho.toString(),
      "X-Goog-Upload-Header-Content-Type":   mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: nome } }),
  });
  if (!iniciaResp.ok) throw new Error(`Upload init: ${iniciaResp.status}`);
  const uploadUrl = iniciaResp.headers.get("x-goog-upload-url");

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset":   "0",
      "X-Goog-Upload-Command":  "upload, finalize",
      "Content-Length":         tamanho.toString(),
    },
    body: blob,
  });
  if (!uploadResp.ok) throw new Error(`Upload bytes: ${uploadResp.status}`);

  const dados = await uploadResp.json();
  const fileUri = dados.file?.uri;
  const fileName = dados.file?.name;
  if (!fileUri || !fileName) throw new Error("URI do arquivo nao retornada");

  // Aguarda processamento (state ACTIVE)
  for (let i = 0; i < 30; i++) {
    const check = await fetch(`${BASE_URL}/${fileName}?key=${chave}`);
    const info = await check.json();
    if (info.state === "ACTIVE") break;
    if (info.state === "FAILED") throw new Error("Gemini nao processou o audio");
    await new Promise(r => setTimeout(r, 2000));
  }

  return fileUri;
}

function blobParaBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// === Download ===
async function baixarAta(textoAta) {
  const blob = new Blob([textoAta], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const agora = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const nome = `ata_${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}.md`;

  await chrome.downloads.download({
    url,
    filename: nome,
    saveAs: false,
  });
}

console.log("[Gravador DM] Offscreen pronto");
