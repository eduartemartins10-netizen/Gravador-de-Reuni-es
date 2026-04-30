/**
 * background.js — service worker da extensao.
 *
 * Responsabilidades nessa versao MVP:
 *  - Detectar quando o usuario entra/sai de uma sala do Google Meet
 *  - Atualizar o icone da extensao para sinalizar visualmente
 *
 * As acoes de gravacao serao adicionadas na proxima etapa.
 */

// URLs de uma sala do Meet seguem o padrao: meet.google.com/abc-defg-hij
function ehUrlSalaDoMeet(url) {
  if (!url) return false;
  // /abc-defg-hij → e uma sala. /home, /lookup, /landing, etc → nao
  return /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);
}

// Atualiza o badge do icone para indicar status
function atualizarBadge(tabId, status) {
  if (status === "sala") {
    chrome.action.setBadgeBackgroundColor({ color: "#10b981", tabId });
    chrome.action.setBadgeText({ text: "•", tabId });
  } else if (status === "gravando") {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    chrome.action.setBadgeText({ text: "REC", tabId });
  } else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
}

// Quando uma aba muda de URL ou e atualizada, reavalia se e Meet
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;

  if (ehUrlSalaDoMeet(tab.url)) {
    atualizarBadge(tabId, "sala");
  } else {
    atualizarBadge(tabId, null);
  }
});

// Quando o usuario muda de aba ativa
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (ehUrlSalaDoMeet(tab.url)) {
      atualizarBadge(tabId, "sala");
    }
  } catch (e) { /* aba pode ter sido fechada */ }
});

// Quando a extensao e instalada
chrome.runtime.onInstalled.addListener(() => {
  console.log("Gravador de Reuniao DM instalado");
});

// Mensagens do content script (vamos usar isso na proxima etapa para receber
// eventos do Meet — quando a sala comeca, quem esta falando, etc)
chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg.tipo === "meet-evento") {
    console.log("Evento do Meet:", msg);
    // Processamento futuro (auto-iniciar gravacao etc)
  }
  if (msg.tipo === "ping") {
    responder({ pong: true, versao: chrome.runtime.getManifest().version });
  }
  return true;
});
