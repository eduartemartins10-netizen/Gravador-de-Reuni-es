/**
 * popup.js — logica da popup da extensao.
 * Detecta se a aba ativa esta em meet.google.com e mostra o estado.
 */

const el = (id) => document.getElementById(id);

// === Estado ===
const ESTADOS = {
  CARREGANDO:    { titulo: "Verificando...",        detalhe: "Aguarde",                            classe: ""        },
  SEM_MEET:      { titulo: "Sem reuniao ativa",     detalhe: "Abra uma reuniao do Google Meet",   classe: ""        },
  PRONTO:        { titulo: "Pronto para gravar",    detalhe: "Reuniao do Meet detectada",         classe: "ativo"   },
  GRAVANDO:      { titulo: "Gravando",              detalhe: "Reuniao em curso",                    classe: "gravando"},
  SEM_CHAVE:     { titulo: "Configure a API",       detalhe: "Adicione a chave do Gemini",         classe: ""        },
};

function aplicarEstado(estado) {
  el("status-titulo").textContent  = estado.titulo;
  el("status-detalhe").textContent = estado.detalhe;
  el("indicador").className = "indicador " + estado.classe;
}

// === Detecta se a aba ativa esta em meet ===
async function abaAtual() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function ehMeet(tab) {
  return tab && tab.url && tab.url.startsWith("https://meet.google.com/");
}

// === Chave da API ===
// Usa storage.sync — sincroniza com sua conta Google entre PCs.
async function chaveSalva() {
  const { gemini_api_key } = await chrome.storage.sync.get("gemini_api_key");
  return gemini_api_key || "";
}

async function salvarChave(chave) {
  await chrome.storage.sync.set({ gemini_api_key: chave });
}

async function removerChave() {
  await chrome.storage.sync.remove("gemini_api_key");
}

// === Estado de gravacao ===
// Mantido em storage.local — gravacao e por PC, nao sincroniza
// (senao um PC pensa que ta gravando quando e outro).
async function estaGravando() {
  const { gravando } = await chrome.storage.local.get("gravando");
  return Boolean(gravando);
}

// === Migracao: storage.local → storage.sync (uma vez) ===
// Se voce ja salvou a chave antes em storage.local, copia para sync.
async function migrarChaveSeNecessario() {
  const localData = await chrome.storage.local.get("gemini_api_key");
  if (localData.gemini_api_key) {
    const syncData = await chrome.storage.sync.get("gemini_api_key");
    if (!syncData.gemini_api_key) {
      await chrome.storage.sync.set({ gemini_api_key: localData.gemini_api_key });
      console.log("[Gravador DM] Chave migrada de local para sync");
    }
    await chrome.storage.local.remove("gemini_api_key");
  }
}

// === Inicializacao ===
async function atualizarEstado() {
  await migrarChaveSeNecessario();
  aplicarEstado(ESTADOS.CARREGANDO);

  const chave = await chaveSalva();
  if (!chave) {
    aplicarEstado(ESTADOS.SEM_CHAVE);
    el("btn-gravar").disabled = true;
    el("btn-gravar").textContent = "Configure a chave primeiro";
    return;
  }

  if (await estaGravando()) {
    aplicarEstado(ESTADOS.GRAVANDO);
    el("btn-gravar").disabled = false;
    el("btn-gravar").textContent = "Parar Gravacao";
    return;
  }

  const tab = await abaAtual();
  if (ehMeet(tab)) {
    aplicarEstado(ESTADOS.PRONTO);
    el("btn-gravar").disabled = false;
    el("btn-gravar").textContent = "Iniciar Gravacao";
  } else {
    aplicarEstado(ESTADOS.SEM_MEET);
    el("btn-gravar").disabled = true;
    el("btn-gravar").textContent = "Iniciar Gravacao";
  }
}

// === Eventos ===
el("btn-config").addEventListener("click", async () => {
  const painel = el("painel-config");
  painel.classList.toggle("painel-oculto");
  if (!painel.classList.contains("painel-oculto")) {
    el("input-chave").value = await chaveSalva();
    el("input-chave").focus();
  }
});

el("btn-cancelar-config").addEventListener("click", () => {
  el("painel-config").classList.add("painel-oculto");
});

el("btn-salvar-chave").addEventListener("click", async () => {
  const chave = el("input-chave").value.trim();
  if (!chave) {
    await removerChave();
    el("input-chave").value = "";
    el("painel-config").classList.add("painel-oculto");
    atualizarEstado();
    return;
  }
  if (!chave.startsWith("AIza") || chave.length < 30) {
    alert("Formato invalido. Chaves do Gemini comecam com 'AIza' e tem 39+ caracteres.");
    return;
  }
  await salvarChave(chave);
  el("painel-config").classList.add("painel-oculto");
  atualizarEstado();
});

el("input-chave").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-salvar-chave").click();
});

el("btn-gravar").addEventListener("click", async () => {
  // Placeholder — a logica real de gravacao virara aqui na proxima etapa
  const gravando = await estaGravando();
  await chrome.storage.local.set({ gravando: !gravando });
  atualizarEstado();
});

// Boot
atualizarEstado();
