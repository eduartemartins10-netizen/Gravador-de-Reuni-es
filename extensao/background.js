/**
 * background.js — service worker da extensao.
 */

const CAMINHO_OFFSCREEN = "offscreen.html";

function ehUrlSalaDoMeet(url) {
  if (!url) return false;
  return /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);
}

function setBadge(tabId, status) {
  if (status === "sala") {
    chrome.action.setBadgeBackgroundColor({ color: "#10b981", tabId });
    chrome.action.setBadgeText({ text: "•", tabId });
  } else if (status === "gravando") {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    chrome.action.setBadgeText({ text: "REC", tabId });
  } else if (status === "processando") {
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b", tabId });
    chrome.action.setBadgeText({ text: "...", tabId });
  } else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
}

// === Deteccao de Meet ===
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  setBadge(tabId, ehUrlSalaDoMeet(tab.url) ? "sala" : null);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (ehUrlSalaDoMeet(tab.url)) setBadge(tabId, "sala");
  } catch (e) {}
});

// === Offscreen helpers ===
async function temOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function criarOffscreenSeNecessario() {
  if (await temOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: CAMINHO_OFFSCREEN,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Gravacao do audio da aba do Meet em background",
  });
}

async function fecharOffscreenSeAberto() {
  if (await temOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
  }
}

// === Listener UNICO de mensagens ===
chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg.alvo !== "background") return false;

  console.log("[bg] mensagem recebida:", msg.tipo);

  switch (msg.tipo) {
    case "iniciar-gravacao":
      iniciarGravacao()
        .then(() => responder({ ok: true }))
        .catch((e) => {
          console.error("[bg] erro em iniciar:", e);
          responder({ ok: false, erro: e.message || String(e) || "Erro sem mensagem" });
        });
      return true;

    case "parar-gravacao":
      pararGravacao()
        .then(() => responder({ ok: true }))
        .catch((e) => {
          console.error("[bg] erro em parar:", e);
          responder({ ok: false, erro: e.message || String(e) || "Erro sem mensagem" });
        });
      return true;

    case "estado-gravacao":
      // Vem da offscreen — processa em paralelo, nao precisa responder
      tratarEstadoGravacao(msg).catch((e) => console.error("[bg] erro estado:", e));
      return false;

    case "baixar":
      // Vem da offscreen — chrome.downloads nao funciona la, fazemos aqui
      chrome.downloads.download({
        url: msg.url,
        filename: msg.nome,
        saveAs: false,
      }).then((id) => {
        console.log("[bg] download iniciado, id:", id, "nome:", msg.nome);
        responder({ ok: true, id });
      }).catch((e) => {
        console.error("[bg] erro no download:", e);
        responder({ ok: false, erro: e.message || String(e) });
      });
      return true;

    default:
      console.warn("[bg] tipo nao reconhecido:", msg.tipo);
      responder({ ok: false, erro: "Tipo de mensagem nao reconhecido: " + msg.tipo });
      return false;
  }
});

async function tratarEstadoGravacao(msg) {
  const { gravando } = await chrome.storage.local.get("gravando");
  const tabId = gravando?.tabId;

  if (msg.estado === "gravando" && tabId) {
    setBadge(tabId, "gravando");
  } else if (msg.estado === "processando" || msg.estado === "subindo") {
    if (tabId) setBadge(tabId, "processando");
  } else if (msg.estado === "concluido" || msg.estado === "erro") {
    if (tabId) setBadge(tabId, "sala");
    await chrome.storage.local.set({ gravando: null });

    if (msg.estado === "erro") {
      await chrome.storage.local.set({
        ultimo_erro: {
          mensagem: msg.mensagem || "Erro sem mensagem",
          audioSalvo: msg.audioSalvo,
          quando: Date.now(),
        },
      });
      chrome.action.setTitle({
        title: `Erro: ${msg.mensagem}`,
        tabId,
      });
    } else {
      await chrome.storage.local.remove("ultimo_erro");
    }
  }
}

// === Acoes ===
async function iniciarGravacao() {
  const [tabAtiva] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabAtiva || !ehUrlSalaDoMeet(tabAtiva.url)) {
    throw new Error("Abra uma sala do Google Meet antes de gravar");
  }

  const { gemini_api_key } = await chrome.storage.sync.get("gemini_api_key");
  if (!gemini_api_key) {
    throw new Error("Configure a chave do Gemini antes de gravar");
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabAtiva.id,
    });
  } catch (e) {
    throw new Error("Falha ao obter streamId: " + (e.message || e));
  }

  await criarOffscreenSeNecessario();

  let resposta;
  let ultimoErro;
  for (let i = 0; i < 5; i++) {
    try {
      resposta = await chrome.runtime.sendMessage({
        alvo: "offscreen",
        tipo: "iniciar",
        streamId,
        apiKey: gemini_api_key,
      });
      if (resposta) break;
    } catch (e) {
      ultimoErro = e;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (!resposta) {
    await fecharOffscreenSeAberto();
    throw new Error("Offscreen nao respondeu. " + (ultimoErro?.message || ""));
  }
  if (!resposta.ok) {
    await fecharOffscreenSeAberto();
    throw new Error(resposta.erro || "Offscreen recusou iniciar a gravacao");
  }

  await chrome.storage.local.set({
    gravando: { tabId: tabAtiva.id, inicio: Date.now() },
  });
}

async function pararGravacao() {
  if (!(await temOffscreen())) {
    await chrome.storage.local.set({ gravando: null });
    throw new Error("Nenhuma gravacao em andamento (offscreen nao existe)");
  }

  let resposta;
  try {
    resposta = await chrome.runtime.sendMessage({
      alvo: "offscreen",
      tipo: "parar",
    });
  } catch (e) {
    throw new Error("Offscreen nao respondeu ao parar: " + (e.message || e));
  }

  if (!resposta) {
    throw new Error("Offscreen retornou resposta vazia ao parar");
  }
  if (!resposta.ok) {
    throw new Error(resposta.erro || "Offscreen recusou parar a gravacao");
  }
  // O offscreen processa o audio e o background recebe "concluido" para limpar.
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Gravador de Reuniao DM instalado/atualizado");
  chrome.storage.local.set({ gravando: null });
});
