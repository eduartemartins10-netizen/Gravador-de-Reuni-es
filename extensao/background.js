/**
 * background.js — service worker da extensao.
 *
 * Responsabilidades:
 *  - Detectar entrada/saida de salas do Meet (badge no icone)
 *  - Orquestrar a gravacao: pedir tabCapture, criar offscreen, sinalizar
 *  - Manter o estado de gravacao em chrome.storage.local
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
    chrome.action.setBadgeText({ text: "..." , tabId });
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
  // Em MV3, ha apenas uma offscreen page por extensao
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function criarOffscreenSeNecessario() {
  if (await temOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: CAMINHO_OFFSCREEN,
    // USER_MEDIA: captura via getUserMedia
    // AUDIO_PLAYBACK: toca o audio de volta para o usuario continuar ouvindo o Meet
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Gravacao do audio da aba do Meet em background",
  });
}

async function fecharOffscreenSeAberto() {
  if (await temOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
  }
}

// === Comandos vindos da popup ===
chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg.alvo !== "background") return false;

  switch (msg.tipo) {
    case "iniciar-gravacao":
      iniciarGravacao()
        .then(() => responder({ ok: true }))
        .catch((e) => responder({ ok: false, erro: e.message }));
      return true;  // resposta sera assincrona

    case "parar-gravacao":
      pararGravacao()
        .then(() => responder({ ok: true }))
        .catch((e) => responder({ ok: false, erro: e.message }));
      return true;

    case "estado-gravacao":
      // Vem da offscreen via outro caminho — ignoramos aqui (tratado abaixo)
      return false;
  }
});

// === Mensagens vindas da offscreen ===
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.alvo !== "background" || msg.tipo !== "estado-gravacao") return;

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
      // Mostra notificacao ao usuario
      chrome.action.setTitle({
        title: `Erro: ${msg.mensagem}`,
        tabId,
      });
    }
  }
});

// === Acoes ===
async function iniciarGravacao() {
  // Procura uma aba do Meet ativa
  const [tabAtiva] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabAtiva || !ehUrlSalaDoMeet(tabAtiva.url)) {
    throw new Error("Abra uma sala do Google Meet antes de gravar");
  }

  // Le a chave da API aqui no background (offscreen nao acessa storage direto).
  const { gemini_api_key } = await chrome.storage.sync.get("gemini_api_key");
  if (!gemini_api_key) {
    throw new Error("Configure a chave do Gemini antes de gravar");
  }

  // Pede um stream-id ao tabCapture (so funciona quando vem da popup/UI)
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabAtiva.id,
  });

  // Garante que ha uma pagina offscreen rodando
  await criarOffscreenSeNecessario();

  // Envia o comando para a offscreen, ja com a chave embutida.
  let resposta;
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
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (!resposta || !resposta.ok) {
    await fecharOffscreenSeAberto();
    throw new Error(resposta?.erro || "Falha ao iniciar a gravacao");
  }

  await chrome.storage.local.set({
    gravando: { tabId: tabAtiva.id, inicio: Date.now() },
  });
}

async function pararGravacao() {
  if (!(await temOffscreen())) {
    await chrome.storage.local.set({ gravando: null });
    throw new Error("Nenhuma gravacao em andamento");
  }

  const resposta = await chrome.runtime.sendMessage({
    alvo: "offscreen",
    tipo: "parar",
  });
  if (!resposta || !resposta.ok) {
    throw new Error(resposta?.erro || "Falha ao parar a gravacao");
  }
  // O offscreen processa o audio e o background recebe "concluido" para limpar.
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Gravador de Reuniao DM instalado/atualizado");
  // Limpa qualquer estado pendente de uma instalacao anterior
  chrome.storage.local.set({ gravando: null });
});
