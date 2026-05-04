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

const PROMPT_ATA = `Voce transcreve audio em portugues brasileiro e gera atas de reunioes.

REGRA CRITICA - SEM ALUCINACAO:
Antes de qualquer coisa, avalie o audio. Se ele estiver:
- silencioso ou inaudivel
- contendo apenas ruido, musica, ou estatica sem fala humana clara
- com fala muito baixa, distorcida ou cortada

ENTAO responda APENAS com:

# AUDIO SEM CONTEUDO

O audio fornecido nao contem fala humana clara o suficiente para transcricao.
Verifique se a captura esta funcionando antes de tentar novamente.

NAO invente conteudo. NAO gere uma ata fictica. NAO use exemplos ou
templates genericos para preencher.

Se o audio TIVER fala clara em portugues, responda no formato abaixo.
Transcreva EXATAMENTE o que foi falado, sem adicionar, inferir ou inventar:

# TRANSCRICAO

(Transcricao fiel ao audio. Identifique falantes diferentes como
"Participante A:", "Participante B:", ou pelo nome real se alguem se
apresentar no audio. Para trechos inaudiveis, escreva [inaudivel].
Preserve nomes proprios e termos tecnicos como foram falados.)

---

# ATA DA REUNIAO

## RESUMO EXECUTIVO

(Baseado APENAS no que foi efetivamente falado no audio.)

## TEMAS ABORDADOS

(Apenas o que foi de fato discutido.)

## DECISOES TOMADAS

(Apenas decisoes explicitas no audio. Se nenhuma, "Nenhuma decisao formal
registrada".)

## ACOES E RESPONSAVEIS

(Apenas acoes mencionadas no audio. Formato:
- [Responsavel] Acao (prazo: X)
Se nenhuma, "Nao mencionado".)

## PONTOS DE ATENCAO

(Apenas pontos explicitos no audio. Se nenhum, "Nao mencionado".)

## PROXIMOS PASSOS

(Apenas o que foi efetivamente mencionado. Se nada, "Nao mencionado".)

REGRAS:
- Cada secao deve refletir SO o que foi falado no audio. Nada inventado.
- Linguagem profissional em portugues brasileiro.
- Substitua palavras de baixo calao por linguagem neutra.
`;

// === Estado ===
let mediaRecorder = null;
let chunks = [];
let streamTab = null;       // audio da aba do Meet (vozes dos outros)
let streamMic = null;       // microfone (sua voz)
let streamMixado = null;    // tab + mic combinados
let audioCtx = null;
let mimeTypeAtual = "audio/webm";
let apiKeyAtiva = null;

// === Mensagens do background ===
chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg.alvo !== "offscreen") return false;

  switch (msg.tipo) {
    case "iniciar":
      apiKeyAtiva = msg.apiKey || null;
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
  if (!streamId) {
    throw new Error("streamId nao recebido");
  }

  console.log("[offscreen] Iniciando captura com streamId:", streamId);

  // 1. Captura o audio da aba do Meet (vozes dos outros)
  try {
    streamTab = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
  } catch (e) {
    throw new Error(`Captura da aba falhou: ${e.message}`);
  }

  const trilhasTab = streamTab.getAudioTracks();
  console.log("[offscreen] Tab audio:", trilhasTab.length, "trilha(s)");
  if (trilhasTab.length === 0) {
    throw new Error("Nenhuma trilha de audio na aba — Meet sem som?");
  }

  // 2. Captura o microfone (sua voz). Se nao conseguir, segue so com a tab.
  try {
    streamMic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const trilhasMic = streamMic.getAudioTracks();
    console.log("[offscreen] Microfone:", trilhasMic.length, "trilha(s)", trilhasMic.map(t => t.label));
  } catch (e) {
    console.warn("[offscreen] Microfone indisponivel:", e.message);
    console.warn("[offscreen] Continuando apenas com a tab. Sua voz NAO sera gravada.");
    streamMic = null;
  }

  // 3. Cria o AudioContext e GARANTE que ele esta rodando.
  //    Em offscreen, ele as vezes nasce suspenso e nunca liga sozinho.
  audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
      console.log("[offscreen] AudioContext resumido. Estado:", audioCtx.state);
    } catch (e) {
      console.warn("[offscreen] Falha ao resumir AudioContext:", e.message);
    }
  }
  console.log("[offscreen] AudioContext estado:", audioCtx.state, "sampleRate:", audioCtx.sampleRate);

  // 4. Cria as fontes e conecta:
  //    - tab + mic → destino (que vira o stream de gravacao)
  //    - tab → ctx.destination (que toca pra voce ouvir o Meet)
  const destinoGravacao = audioCtx.createMediaStreamDestination();

  const fonteTab = audioCtx.createMediaStreamSource(streamTab);
  fonteTab.connect(destinoGravacao);
  fonteTab.connect(audioCtx.destination); // playback pelo proprio AudioContext

  if (streamMic) {
    const fonteMic = audioCtx.createMediaStreamSource(streamMic);
    fonteMic.connect(destinoGravacao);
    // microfone NAO vai para audioCtx.destination — evita feedback
    console.log("[offscreen] Mixagem: tab + microfone");
  } else {
    console.log("[offscreen] Mixagem: tab apenas (sem microfone)");
  }

  streamMixado = destinoGravacao.stream;
  console.log("[offscreen] Stream mixado tracks:", streamMixado.getAudioTracks().length);

  // 5. Configura o MediaRecorder com o stream mixado
  const tiposSuportados = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  mimeTypeAtual = tiposSuportados.find(t => MediaRecorder.isTypeSupported(t)) || "audio/webm";
  console.log("[offscreen] MIME type:", mimeTypeAtual);

  chunks = [];
  mediaRecorder = new MediaRecorder(streamMixado, { mimeType: mimeTypeAtual });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      // Loga so a cada 10 chunks pra nao poluir
      if (chunks.length % 10 === 0) {
        console.log(`[offscreen] ${chunks.length} chunks capturados`);
      }
    }
  };
  mediaRecorder.onerror = (e) => {
    console.error("[offscreen] MediaRecorder erro:", e);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mimeTypeAtual });
    console.log(`[offscreen] Gravacao parada. Total: ${chunks.length} chunks, ${(blob.size/1024/1024).toFixed(1)} MB`);
    chunks = [];
    avisarBackground("processando", { tamanho: blob.size });

    // 1. SEMPRE salva o audio bruto antes de qualquer coisa — backup.
    let audioSalvoOk = false;
    try {
      await baixarAudio(blob);
      audioSalvoOk = true;
      console.log("[offscreen] Audio bruto salvo em Downloads como backup");
    } catch (e) {
      console.error("[offscreen] Falha ao salvar audio bruto:", e);
    }

    // 2. Tenta gerar a ata com o Gemini.
    try {
      if (blob.size < 1000) {
        throw new Error("Audio capturado vazio (< 1 KB) — nada para transcrever");
      }
      const ata = await processarComGemini(blob);

      // Salva a ata e pede ao background pra abrir a pagina de resultado.
      await pedirAberturaResultado(ata);
      console.log("[offscreen] Ata salva — pagina de resultado aberta no navegador");
      avisarBackground("concluido", { ata });

      // So fecha o offscreen quando deu tudo certo.
      setTimeout(() => window.close(), 1000);
    } catch (e) {
      console.error("[offscreen] Falha no processamento Gemini:", e);
      console.log("[offscreen] Audio bruto disponivel na pasta Downloads:", audioSalvoOk ? "sim" : "NAO");
      console.log("[offscreen] Esta pagina vai ficar aberta para voce ver os logs.");
      avisarBackground("erro", {
        mensagem: e.message,
        audioSalvo: audioSalvoOk,
      });
      // NAO fecha — deixa o usuario ver o erro no console
    }
  };

  mediaRecorder.start(1000);  // chunks a cada 1s
  console.log("[offscreen] MediaRecorder iniciado");
  avisarBackground("gravando");
}

async function pararGravacao() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    throw new Error("Nada para parar");
  }
  mediaRecorder.stop();

  // Para todos os streams para liberar a aba e o microfone
  if (streamTab) {
    streamTab.getTracks().forEach(t => t.stop());
    streamTab = null;
  }
  if (streamMic) {
    streamMic.getTracks().forEach(t => t.stop());
    streamMic = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
  streamMixado = null;
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
  if (!apiKeyAtiva) {
    throw new Error("Chave da API nao recebida do background");
  }

  let partAudio;
  if (blob.size < LIMITE_INLINE) {
    const base64 = await blobParaBase64(blob);
    partAudio = {
      inline_data: { mime_type: blob.type || "audio/webm", data: base64 },
    };
  } else {
    avisarBackground("subindo");
    const fileUri = await uploadArquivo(apiKeyAtiva, blob);
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
        return await chamarGemini(apiKeyAtiva, modelo, parts);
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
// chrome.downloads nao e acessivel em offscreen — pedimos ao background.
function timestampNome() {
  const agora = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}`;
}

async function pedirDownloadAoBackground(blob, nome) {
  // Cria a URL do blob na offscreen e passa para o background.
  // O blob URL fica acessivel enquanto a offscreen estiver viva.
  const url = URL.createObjectURL(blob);
  try {
    const resp = await chrome.runtime.sendMessage({
      alvo: "background",
      tipo: "baixar",
      url,
      nome,
    });
    if (!resp || !resp.ok) {
      throw new Error(resp?.erro || "Background nao confirmou o download");
    }
  } finally {
    // Aguarda 5s antes de revogar para o Chrome ter tempo de capturar o conteudo
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function baixarAta(textoAta) {
  const blob = new Blob([textoAta], { type: "text/markdown;charset=utf-8" });
  await pedirDownloadAoBackground(blob, `ata_${timestampNome()}.md`);
}

async function pedirAberturaResultado(textoAta) {
  // chrome.storage nao funciona em offscreen — pedimos ao background
  // pra salvar e abrir a aba em uma operacao so.
  const resp = await chrome.runtime.sendMessage({
    alvo: "background",
    tipo: "abrir-resultado",
    ata: textoAta,
  });
  if (!resp || !resp.ok) {
    throw new Error(resp?.erro || "Background nao confirmou a abertura do resultado");
  }
}

async function baixarAudio(blobAudio) {
  const ext = blobAudio.type.includes("ogg") ? "ogg" : "webm";
  await pedirDownloadAoBackground(blobAudio, `reuniao_${timestampNome()}.${ext}`);
}

console.log("[Gravador DM] Offscreen pronto");
