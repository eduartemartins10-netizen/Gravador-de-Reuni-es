/**
 * Gravador de Reunião — versão web
 * Tudo roda no navegador. A unica chamada externa e para a API do Gemini.
 */

const MODELO_GEMINI   = "gemini-2.5-flash";
const MODELOS_FALLBACK = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
const BASE_URL        = "https://generativelanguage.googleapis.com/v1beta";
const LIMITE_INLINE   = 18 * 1024 * 1024;
const INTERVALO_LIVE_MS = 2000;  // chunk minimo viavel (fallback se WebSocket falhar)
const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODELO_LIVE = "models/gemini-2.5-flash-native-audio-latest";
const PROMPT_ATA = `Voce e um assistente especializado em atas profissionais de reunioes.
Abaixo esta uma gravacao em audio de uma reuniao.

Gere sua resposta no formato exato abaixo, em duas partes:

# TRANSCRICAO
(A transcricao completa do audio, corrigida pelo contexto, preservando termos
tecnicos em ingles — deploy, deadline, sprint, bug, etc.
Se houver mais de um falante, separe em paragrafos e identifique — ex:
"Participante A: ...", "Participante B: ...", ou o nome se alguem se apresentar.)

---

# ATA DA REUNIAO

## RESUMO EXECUTIVO
(2-3 paragrafos)

## TEMAS ABORDADOS
(Lista)

## DECISOES TOMADAS
(Lista. Se nenhuma, escreva "Nenhuma decisao formal registrada")

## ACOES E RESPONSAVEIS
(Formato: - [Responsavel] Acao (prazo: X))

## PONTOS DE ATENCAO

## PROXIMOS PASSOS

REGRAS:
- Linguagem profissional e objetiva
- Substitua palavras de baixo calao por linguagem neutra
- Preserve termos tecnicos em EN no idioma original
- Se o audio for silencioso ou incompleto, diga "Audio sem conteudo suficiente para ata"
`;

// === Estado ===
let mediaRecorder = null;       // recorder principal (grava a reuniao inteira)
let recorderLive  = null;       // fallback: recorder em chunks se WebSocket falhar
let chunks        = [];
let audioStreamMixado = null;
let ctxAudio      = null;
let timerInterval = null;
let inicioGravacao = null;
let atualBlob     = null;
let atualAta      = "";
let transcricaoAoVivo = "";
let mimeTypeAtual = "audio/webm";

// Live streaming via WebSocket
let wsLive        = null;
let processorAudio = null;
let sourceAnalise = null;
let silentSink    = null;

// === Elementos ===
const el = (id) => document.getElementById(id);

// === Setup / chave ===
function chaveSalva() {
  return localStorage.getItem("gemini_api_key") || "";
}

function mostrarTela(id) {
  ["tela-setup", "tela-gravador", "tela-resultado"]
    .forEach(t => el(t).classList.add("oculta"));
  el(id).classList.remove("oculta");
}

function inicializar() {
  if (chaveSalva()) {
    mostrarTela("tela-gravador");
  } else {
    mostrarTela("tela-setup");
    el("input-chave").focus();
  }
}

el("btn-salvar-chave").addEventListener("click", async () => {
  const chave = el("input-chave").value.trim();
  if (!chave) {
    el("status-chave").textContent = "Cole a chave antes de salvar.";
    el("status-chave").className = "status erro";
    return;
  }

  // Checagem basica de formato: chaves do Google AI Studio comecam com "AIza"
  if (!chave.startsWith("AIza") || chave.length < 30) {
    el("status-chave").textContent =
      "Formato invalido. Chaves do Gemini comecam com 'AIza'.";
    el("status-chave").className = "status erro";
    return;
  }

  el("status-chave").textContent = "Validando...";
  el("status-chave").className = "status";

  try {
    await chamarGemini(chave, MODELO_GEMINI, [{ text: "ping" }]);
    localStorage.setItem("gemini_api_key", chave);
    el("status-chave").textContent = "✓ Chave salva!";
    el("status-chave").className = "status sucesso";
    setTimeout(() => mostrarTela("tela-gravador"), 600);
  } catch (e) {
    // Erros de servidor (503/429/500/etc) NAO significam chave invalida —
    // salvamos mesmo assim e avisamos o usuario
    const erroDeServidor = [429, 500, 502, 503, 504].includes(e.status);
    const erroDeChave = e.status === 400 || e.status === 403 ||
                         /API_KEY_INVALID|API key not valid/i.test(e.message);

    if (erroDeChave) {
      el("status-chave").textContent = "Chave invalida: " + e.message;
      el("status-chave").className = "status erro";
    } else if (erroDeServidor || !e.status) {
      // Salva assim mesmo — o Gemini ta sobrecarregado ou sem rede
      localStorage.setItem("gemini_api_key", chave);
      el("status-chave").textContent =
        "⚠ Nao validei (servidor ocupado), mas salvei. Avance e tente gravar.";
      el("status-chave").className = "status";
      setTimeout(() => mostrarTela("tela-gravador"), 1500);
    } else {
      el("status-chave").textContent = "Erro: " + e.message;
      el("status-chave").className = "status erro";
    }
  }
});

el("input-chave").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-salvar-chave").click();
});

el("btn-trocar-chave").addEventListener("click", () => {
  localStorage.removeItem("gemini_api_key");
  el("input-chave").value = "";
  mostrarTela("tela-setup");
});

// === Captura de áudio ===
async function capturarStreams() {
  const capMic = el("capturar-mic").checked;
  const capSistema = el("capturar-sistema").checked;

  if (!capMic && !capSistema) {
    throw new Error("Marque pelo menos uma opcao de captura.");
  }

  const streams = [];

  if (capMic) {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });
    streams.push(micStream);
  }

  if (capSistema) {
    // Pede ao usuario para compartilhar a tela/aba COM audio
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,  // necessario para ter audio tambem em alguns browsers
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
      }
    });
    // Remove o video track — so queremos o audio
    displayStream.getVideoTracks().forEach(t => t.stop());
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("Nenhum audio compartilhado. Marque 'Compartilhar audio do sistema' na caixa do navegador.");
    }
    const soAudio = new MediaStream(audioTracks);
    streams.push(soAudio);
  }

  // Mixa todos os streams via Web Audio API
  ctxAudio = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const destino = ctxAudio.createMediaStreamDestination();

  streams.forEach(s => {
    const src = ctxAudio.createMediaStreamSource(s);
    const gain = ctxAudio.createGain();
    gain.gain.value = 1.0;
    src.connect(gain);
    gain.connect(destino);
  });

  audioStreamMixado = destino.stream;
  return { streamMixado: destino.stream, streamsOriginais: streams };
}

function pararStreams(streams) {
  streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  if (ctxAudio) {
    ctxAudio.close();
    ctxAudio = null;
  }
}

// === Gravação ===
let streamsOriginais = [];

el("btn-gravar").addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    pararGravacao();
  } else {
    await iniciarGravacao();
  }
});

async function iniciarGravacao() {
  el("btn-gravar").disabled = true;
  try {
    const { streamMixado, streamsOriginais: streams } = await capturarStreams();
    streamsOriginais = streams;

    chunks = [];
    transcricaoAoVivo = "";
    el("texto-ao-vivo").innerHTML = "";

    const tiposSuportados = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    mimeTypeAtual = tiposSuportados.find(t => MediaRecorder.isTypeSupported(t)) || "audio/webm";

    // Recorder PRINCIPAL: grava a reuniao inteira, gera o blob final
    mediaRecorder = new MediaRecorder(streamMixado, { mimeType: mimeTypeAtual });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      pararStreams(streamsOriginais);
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      atualBlob = blob;
      await processar(blob);
    };
    mediaRecorder.start(1000);

    // Transcricao ao vivo: tenta WebSocket (tempo real); cai em chunks se falhar
    if (el("transcricao-ao-vivo").checked) {
      el("painel-ao-vivo").classList.remove("oculto");
      el("ao-vivo-status").textContent = "Conectando...";
      try {
        await iniciarLiveStreaming(streamMixado, chaveSalva());
        el("ao-vivo-status").textContent = "● ao vivo (streaming)";
      } catch (err) {
        console.warn("Live streaming indisponivel, caindo em chunks:", err.message);
        el("ao-vivo-status").textContent =
          `(Sem streaming — usando chunks rapidos de ${INTERVALO_LIVE_MS/1000}s)`;
        iniciarCicloLive(streamMixado);
      }
    }

    inicioGravacao = Date.now();
    document.body.classList.add("gravando");
    el("status").textContent = "🔴 Gravando...";
    el("btn-gravar").classList.add("parar");
    el("btn-texto").textContent = "Parar Gravação";
    el("btn-gravar").disabled = false;

    timerInterval = setInterval(atualizarTimer, 1000);
    atualizarTimer();
  } catch (e) {
    el("btn-gravar").disabled = false;
    alert("Nao foi possivel iniciar a gravacao:\n\n" + e.message);
    console.error(e);
  }
}

function pararGravacao() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  // Encerra streams live (WebSocket ou fallback de chunks)
  pararLiveStreaming();
  pararCicloLive();

  mediaRecorder.stop();
  clearInterval(timerInterval);
  document.body.classList.remove("gravando");
  document.body.classList.add("processando");
  el("status").textContent = "Processando...";
  el("btn-gravar").classList.remove("parar");
  el("btn-texto").textContent = "Iniciar Gravação";
  el("timer").textContent = "";
}

// === Live streaming via Gemini Live API (WebSocket) ===
async function iniciarLiveStreaming(stream, chave) {
  if (!chave) throw new Error("Sem chave da API");

  // 1. Conecta WebSocket
  const url = `${WS_URL}?key=${chave}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  // 2. Aguarda abertura e envia setup
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout ao abrir WebSocket")), 10000);
    ws.onopen = () => {
      clearTimeout(timeout);
      // Modelos native-audio exigem responseModalities=AUDIO
      // (eles geram audio de volta, mas a gente ignora — so usa inputAudioTranscription)
      ws.send(JSON.stringify({
        setup: {
          model: MODELO_LIVE,
          generationConfig: {
            responseModalities: ["AUDIO"],
          },
          systemInstruction: {
            parts: [{
              text: "Apenas escute em silencio. Nao responda. "
                  + "O usuario quer apenas a transcricao do audio que ele enviar."
            }]
          },
          inputAudioTranscription: {},
        }
      }));
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error("WebSocket erro na abertura"));
    };
  });

  // 3. Aguarda setupComplete
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout aguardando setupComplete")), 10000);
    const handler = (evt) => {
      try {
        const data = JSON.parse(typeof evt.data === "string" ? evt.data
                                : new TextDecoder().decode(evt.data));
        if (data.setupComplete) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve();
        } else if (data.error) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          reject(new Error(data.error.message || "Setup rejeitado"));
        }
      } catch (e) {}
    };
    ws.addEventListener("message", handler);
  });

  // 4. Listeners permanentes — processa SO inputTranscription
  // (ignoramos o audio que o modelo gera de volta e qualquer modelTurn)
  ws.addEventListener("message", (evt) => {
    try {
      const payload = typeof evt.data === "string" ? evt.data
                       : new TextDecoder().decode(evt.data);
      const data = JSON.parse(payload);

      const trans = data.serverContent?.inputTranscription?.text;
      if (trans) appendTranscricaoAoVivo(trans, true);

      // Se o modelo enviar texto explicito (alguns modelos enviam), tambem usamos
      const parts = data.serverContent?.modelTurn?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) appendTranscricaoAoVivo(p.text, true);
        }
      }
    } catch (e) {
      // Mensagens com audio inline_data binario podem nao ser JSON puro — ignoramos
    }
  });

  ws.addEventListener("close", () => {
    console.log("WebSocket live fechado");
    wsLive = null;
  });

  wsLive = ws;

  // 5. Conecta o processor de audio ao stream
  conectarProcessorDeAudio(stream);
}

function conectarProcessorDeAudio(stream) {
  if (!ctxAudio) return;

  // ScriptProcessor: ao receber samples, downsample 48k→16k e envia base64 PCM
  processorAudio = ctxAudio.createScriptProcessor(4096, 1, 1);
  silentSink     = ctxAudio.createGain();
  silentSink.gain.value = 0;

  sourceAnalise = ctxAudio.createMediaStreamSource(stream);
  sourceAnalise.connect(processorAudio);
  processorAudio.connect(silentSink);
  silentSink.connect(ctxAudio.destination);

  const inRate = ctxAudio.sampleRate; // ~48000
  const outRate = 16000;

  processorAudio.onaudioprocess = (e) => {
    if (!wsLive || wsLive.readyState !== WebSocket.OPEN) return;

    const input = e.inputBuffer.getChannelData(0);

    // Decimacao simples (48k → 16k)
    const ratio = inRate / outRate;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      out[i] = input[Math.floor(i * ratio)];
    }

    // Float32 [-1, 1] → Int16 PCM
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, out[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Base64 (chunks pra nao estourar call stack em btoa)
    const bytes = new Uint8Array(pcm.buffer);
    let binario = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binario += String.fromCharCode.apply(
        null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
      );
    }
    const base64 = btoa(binario);

    wsLive.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: "audio/pcm;rate=16000",
          data: base64,
        }],
      },
    }));
  };
}

function pararLiveStreaming() {
  if (processorAudio) {
    try { processorAudio.disconnect(); } catch (_) {}
    processorAudio = null;
  }
  if (sourceAnalise) {
    try { sourceAnalise.disconnect(); } catch (_) {}
    sourceAnalise = null;
  }
  if (silentSink) {
    try { silentSink.disconnect(); } catch (_) {}
    silentSink = null;
  }
  if (wsLive) {
    try { wsLive.close(); } catch (_) {}
    wsLive = null;
  }
}

// === Transcricao ao vivo (ciclo de recorders de 15s cada) ===
function iniciarCicloLive(stream) {
  function criarRecorderLive() {
    const chunksLive = [];
    const mr = new MediaRecorder(stream, { mimeType: mimeTypeAtual });
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksLive.push(e.data);
    };
    mr.onstop = () => {
      if (chunksLive.length === 0) return;
      const blob = new Blob(chunksLive, { type: mimeTypeAtual });
      transcreverChunkAoVivo(blob);
    };
    mr.start();
    recorderLive = mr;

    setTimeout(() => {
      if (mr.state === "recording" && recorderLive === mr) {
        mr.stop();
        criarRecorderLive(); // proximo ciclo
      }
    }, INTERVALO_LIVE_MS);  // 5s em modo fallback
  }
  criarRecorderLive();
}

function pararCicloLive() {
  if (recorderLive && recorderLive.state === "recording") {
    const mr = recorderLive;
    recorderLive = null; // evita que o setTimeout crie outro
    mr.stop();
  } else {
    recorderLive = null;
  }
}

async function transcreverChunkAoVivo(blob) {
  const chave = chaveSalva();
  if (!chave) return;

  el("ao-vivo-status").textContent = "Transcrevendo...";
  try {
    const base64 = await blobParaBase64(blob);
    const parts = [
      { text: "Transcreva este trecho curto de audio em portugues. "
             + "Responda APENAS com o texto falado (pode ser uma frase parcial). "
             + "Sem comentarios, sem formatacao, sem aspas. "
             + "Se o audio for silencio puro, responda vazio. "
             + "Se tiver mesmo um pedaco de palavra, transcreva o pedaco." },
      { inline_data: { mime_type: blob.type || "audio/webm", data: base64 } },
    ];
    // Usa modelo mais rapido pra chunks curtos (menor latencia)
    const texto = await chamarGemini(chave, "gemini-2.5-flash-lite", parts);
    appendTranscricaoAoVivo(texto);
  } catch (e) {
    if (e.status === 429) {
      el("ao-vivo-status").textContent = "Rate limit — aguardando...";
    } else {
      console.warn("Chunk ao vivo falhou:", e.message);
      el("ao-vivo-status").textContent = "Falha temporaria — tentando o proximo...";
    }
  }
}

// fragmentosStream = true quando vem via WebSocket (palavra a palavra);
// false quando vem de chunk de 15s (bloco completo com timestamp)
function appendTranscricaoAoVivo(texto, fragmentoStream = false) {
  texto = texto || "";
  if (!fragmentoStream) texto = texto.trim();
  if (!texto || texto === "..." || texto === "…") return;

  const painel = el("texto-ao-vivo");

  if (fragmentoStream) {
    // Modo streaming: adiciona ao ultimo bloco (ou cria o primeiro)
    let ultimo = painel.querySelector(".live-linha:last-child");
    if (!ultimo) {
      ultimo = document.createElement("div");
      ultimo.className = "live-linha chunk-novo";
      painel.appendChild(ultimo);
    }
    ultimo.appendChild(document.createTextNode(texto));
    transcricaoAoVivo += texto;

    // Detecta fim de frase → cria linha nova
    if (/[.!?]\s*$/.test(texto)) {
      const nova = document.createElement("div");
      nova.className = "live-linha";
      painel.appendChild(nova);
      transcricaoAoVivo += "\n";
    }
  } else {
    // Modo chunk (fallback): um bloco com timestamp
    const agora = new Date();
    const hora = String(agora.getHours()).padStart(2, "0")
               + ":" + String(agora.getMinutes()).padStart(2, "0")
               + ":" + String(agora.getSeconds()).padStart(2, "0");
    const bloco = document.createElement("div");
    bloco.className = "live-linha chunk-novo";
    bloco.innerHTML = `<small style="color:#666">[${hora}]</small> ${escapeHtml(texto)}`;
    painel.appendChild(bloco);
    transcricaoAoVivo += (transcricaoAoVivo ? "\n\n" : "") + `[${hora}] ${texto}`;
  }

  painel.scrollTop = painel.scrollHeight;
  el("ao-vivo-status").textContent = wsLive ? "● ao vivo (streaming)" : "● ao vivo";
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function atualizarTimer() {
  const dec = Math.floor((Date.now() - inicioGravacao) / 1000);
  const h = Math.floor(dec / 3600);
  const m = Math.floor((dec % 3600) / 60);
  const s = dec % 60;
  el("timer").textContent = h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// === Processamento com Gemini (streaming) ===
async function processar(blob) {
  mostrarTela("tela-resultado");
  document.body.classList.add("processando");
  document.body.classList.remove("gravando");

  // Reset da UI
  atualAta = "";
  el("previa-ata").textContent = "";
  el("titulo-resultado").innerHTML =
    '<span class="spinner-inline"></span> Preparando upload...';
  el("subtitulo-resultado").textContent =
    `Áudio: ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  el("btn-baixar-ata").disabled = true;

  try {
    const chave = chaveSalva();
    if (!chave) throw new Error("Chave da API nao configurada.");

    let partAudio;
    if (blob.size < LIMITE_INLINE) {
      const base64 = await blobParaBase64(blob);
      partAudio = {
        inline_data: { mime_type: blob.type || "audio/webm", data: base64 }
      };
    } else {
      el("titulo-resultado").innerHTML =
        '<span class="spinner-inline"></span> Subindo áudio...';
      const fileUri = await uploadArquivo(chave, blob);
      partAudio = {
        file_data: { mime_type: blob.type || "audio/webm", file_uri: fileUri }
      };
    }

    el("titulo-resultado").innerHTML =
      '<span class="spinner-inline"></span> Transcrevendo em tempo real...';
    el("subtitulo-resultado").textContent =
      "Acompanhe o texto aparecendo abaixo conforme a IA gera";

    const parts = [{ text: PROMPT_ATA }, partAudio];

    // Streaming: atualiza a UI a cada pedaco que chega do Gemini
    await streamComFallback(chave, parts, (pedaco) => {
      atualAta += pedaco;
      renderizarPreview(atualAta);
    });

    concluirStreaming();

  } catch (e) {
    console.error(e);
    document.body.classList.remove("processando");
    el("titulo-resultado").innerHTML = "❌ Erro";
    el("subtitulo-resultado").textContent = e.message;
    el("subtitulo-resultado").className = "status erro";
  }
}

function renderizarPreview(texto) {
  const pre = el("previa-ata");
  pre.innerHTML = "";
  pre.appendChild(document.createTextNode(texto));
  const cursor = document.createElement("span");
  cursor.className = "cursor-digitando";
  pre.appendChild(cursor);
  // Auto-scroll suave
  const container = pre.parentElement;
  container.scrollTop = container.scrollHeight;
}

function concluirStreaming() {
  // Remove o cursor
  el("previa-ata").innerHTML = "";
  el("previa-ata").appendChild(document.createTextNode(atualAta));

  document.body.classList.remove("processando");
  document.body.classList.add("pronto");

  el("titulo-resultado").innerHTML = "✓ Ata gerada!";
  el("subtitulo-resultado").textContent =
    "Você pode baixar a ata em Markdown ou o áudio original.";
  el("subtitulo-resultado").className = "status sucesso";
  el("btn-baixar-ata").disabled = false;
}

function blobParaBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function uploadArquivo(chave, blob) {
  // Inicia upload resumable
  const tamanho = blob.size;
  const mime    = blob.type || "audio/webm";
  const nome    = `reuniao_${Date.now()}`;

  const iniciaResp = await fetch(
    `${BASE_URL}/files?key=${chave}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command":  "start",
        "X-Goog-Upload-Header-Content-Length": tamanho.toString(),
        "X-Goog-Upload-Header-Content-Type":   mime,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: nome } }),
    }
  );
  if (!iniciaResp.ok) throw new Error(`Upload init: ${iniciaResp.status}`);
  const uploadUrl = iniciaResp.headers.get("x-goog-upload-url");

  // Envia os bytes
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Length": tamanho.toString(),
    },
    body: blob,
  });
  if (!uploadResp.ok) throw new Error(`Upload bytes: ${uploadResp.status}`);

  const dados = await uploadResp.json();
  const fileUri = dados.file?.uri;
  if (!fileUri) throw new Error("URI do arquivo nao retornada");

  // Aguarda o Gemini processar o audio (state ACTIVE)
  const fileName = dados.file?.name;
  for (let tentativa = 0; tentativa < 30; tentativa++) {
    const check = await fetch(`${BASE_URL}/${fileName}?key=${chave}`);
    const info = await check.json();
    if (info.state === "ACTIVE") break;
    if (info.state === "FAILED") throw new Error("Gemini nao conseguiu processar o audio");
    await new Promise(r => setTimeout(r, 2000));
  }

  return fileUri;
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

async function chamarGeminiComFallback(chave, parts) {
  let ultimoErro = null;
  for (const modelo of MODELOS_FALLBACK) {
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      try {
        return await chamarGemini(chave, modelo, parts);
      } catch (e) {
        ultimoErro = e;
        console.warn(`${modelo} tentativa ${tentativa} falhou: ${e.message}`);
        const transiente = [429, 500, 502, 503, 504].includes(e.status);
        if (!transiente) break;
        await new Promise(r => setTimeout(r, Math.min(3000 * 2 ** (tentativa - 1), 30000)));
      }
    }
  }
  throw ultimoErro || new Error("Todos os modelos falharam");
}

/**
 * Streaming via SSE: chama streamGenerateContent e invoca onPedaco(texto)
 * a cada fragmento que chega. Retorna quando o stream termina.
 */
async function streamGemini(chave, modelo, parts, onPedaco) {
  const url = `${BASE_URL}/models/${modelo}:streamGenerateContent?key=${chave}&alt=sse`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });

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

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const linhas = buffer.split("\n");
    buffer = linhas.pop() || "";

    for (const linha of linhas) {
      if (!linha.startsWith("data: ")) continue;
      const payload = linha.slice(6).trim();
      if (!payload) continue;
      try {
        const dados = JSON.parse(payload);
        const texto = dados.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) onPedaco(texto);
      } catch (err) {
        console.warn("SSE parse error:", err, payload.slice(0, 100));
      }
    }
  }
}

async function streamComFallback(chave, parts, onPedaco) {
  let ultimoErro = null;
  for (const modelo of MODELOS_FALLBACK) {
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      try {
        // Acumula o que ja saiu antes do erro, para nao repetir ao reconectar
        let acumulado = "";
        const interceptor = (pedaco) => {
          acumulado += pedaco;
          onPedaco(pedaco);
        };
        await streamGemini(chave, modelo, parts, interceptor);
        return;
      } catch (e) {
        ultimoErro = e;
        console.warn(`stream ${modelo} tentativa ${tentativa} falhou: ${e.message}`);
        const transiente = [429, 500, 502, 503, 504].includes(e.status);
        if (!transiente) break;
        await new Promise(r => setTimeout(r, Math.min(3000 * 2 ** (tentativa - 1), 30000)));
      }
    }
  }
  throw ultimoErro || new Error("Todos os modelos falharam");
}

// === Resultado / downloads ===
el("btn-baixar-ata").addEventListener("click", () => {
  const blob = new Blob([atualAta], { type: "text/markdown;charset=utf-8" });
  baixar(blob, `ata_${timestamp()}.md`);
});

el("btn-baixar-audio").addEventListener("click", () => {
  if (!atualBlob) return;
  const ext = (atualBlob.type.includes("ogg") ? "ogg" : "webm");
  baixar(atualBlob, `reuniao_${timestamp()}.${ext}`);
});

el("btn-nova").addEventListener("click", () => {
  document.body.className = "";
  atualBlob = null;
  atualAta = "";
  chunks = [];
  transcricaoAoVivo = "";
  el("previa-ata").textContent = "";
  el("timer").textContent = "";
  el("status").textContent = "Pronto para gravar";
  el("subtitulo-resultado").className = "status";
  el("texto-ao-vivo").innerHTML = "";
  el("ao-vivo-status").textContent = "Aguardando primeira fala...";
  el("painel-ao-vivo").classList.add("oculto");
  mostrarTela("tela-gravador");
});

function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// === Inicialização ===
inicializar();
