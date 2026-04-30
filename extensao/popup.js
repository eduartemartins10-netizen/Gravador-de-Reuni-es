/**
 * popup.js — popup da extensao.
 * Mostra status, dispara gravacao via background.
 */

const el = (id) => document.getElementById(id);

const ESTADOS = {
  CARREGANDO:   { titulo: "Verificando...",       detalhe: "Aguarde",                          classe: ""        },
  SEM_MEET:     { titulo: "Sem reuniao ativa",    detalhe: "Abra uma sala do Google Meet",     classe: ""        },
  PRONTO:       { titulo: "Pronto para gravar",   detalhe: "Reuniao do Meet detectada",        classe: "ativo"   },
  GRAVANDO:     { titulo: "Gravando",             detalhe: "Reuniao em curso",                 classe: "gravando"},
  PROCESSANDO:  { titulo: "Processando",          detalhe: "Gerando ata com IA...",            classe: "ativo"   },
  SEM_CHAVE:    { titulo: "Configure a API",      detalhe: "Adicione a chave do Gemini",       classe: ""        },
};

function aplicarEstado(estado) {
  el("status-titulo").textContent  = estado.titulo;
  el("status-detalhe").textContent = estado.detalhe;
  el("indicador").className = "indicador " + estado.classe;
}

async function abaAtual() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function ehMeet(tab) {
  return tab && tab.url && tab.url.startsWith("https://meet.google.com/");
}

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

async function estadoAtualGravacao() {
  const { gravando } = await chrome.storage.local.get("gravando");
  return gravando;
}

async function migrarChaveSeNecessario() {
  const localData = await chrome.storage.local.get("gemini_api_key");
  if (localData.gemini_api_key) {
    const syncData = await chrome.storage.sync.get("gemini_api_key");
    if (!syncData.gemini_api_key) {
      await chrome.storage.sync.set({ gemini_api_key: localData.gemini_api_key });
    }
    await chrome.storage.local.remove("gemini_api_key");
  }
}

async function atualizarEstado() {
  await migrarChaveSeNecessario();

  const chave = await chaveSalva();
  if (!chave) {
    aplicarEstado(ESTADOS.SEM_CHAVE);
    el("btn-gravar").disabled = true;
    el("btn-gravar").textContent = "Configure a chave primeiro";
    return;
  }

  const gravando = await estadoAtualGravacao();
  if (gravando) {
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

// === Eventos de UI ===
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
  el("btn-gravar").disabled = true;
  const gravando = await estadoAtualGravacao();

  try {
    const resp = await chrome.runtime.sendMessage({
      alvo: "background",
      tipo: gravando ? "parar-gravacao" : "iniciar-gravacao",
    });
    if (!resp || !resp.ok) {
      throw new Error(resp?.erro || "Falha desconhecida");
    }

    if (!gravando) {
      // Acabou de iniciar
      aplicarEstado(ESTADOS.GRAVANDO);
      el("btn-gravar").textContent = "Parar Gravacao";
    } else {
      // Acabou de parar
      aplicarEstado(ESTADOS.PROCESSANDO);
      el("btn-gravar").textContent = "Aguarde...";
    }
  } catch (e) {
    alert("Erro: " + e.message);
    atualizarEstado();
  } finally {
    el("btn-gravar").disabled = false;
  }
});

// Atualiza o estado se algo mudar enquanto a popup esta aberta
chrome.storage.onChanged.addListener((changes) => {
  if (changes.gravando) atualizarEstado();
});

atualizarEstado();
