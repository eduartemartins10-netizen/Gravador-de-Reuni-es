/**
 * content.js — script injetado nas paginas do meet.google.com.
 *
 * Responsabilidades nessa versao MVP:
 *  - Detectar quando o usuario entrou efetivamente na sala (nao so na lobby)
 *  - Avisar o background script que ha uma sala ativa
 *
 * Speaker detection e captura de audio virao na proxima etapa.
 */

console.log("[Gravador DM] content script carregado em:", window.location.href);

let salaAtiva = false;

/**
 * Detecta se o usuario ja entrou na sala (nao mais na lobby).
 * Usa elementos visiveis quando a chamada esta ativa: o botao "Sair da chamada"
 * (icone de fone vermelho) e o painel inferior.
 */
function dentroDaSala() {
  // Botao de "Sair da chamada" — aparece so quando ja entrou
  const botaoSair = document.querySelector('[aria-label*="Sair da chamada" i], [aria-label*="Leave call" i]');
  return Boolean(botaoSair);
}

/**
 * Avisa o background sempre que o estado mudar.
 */
function avisarEstado() {
  const dentro = dentroDaSala();
  if (dentro !== salaAtiva) {
    salaAtiva = dentro;
    chrome.runtime.sendMessage({
      tipo: "meet-evento",
      acao: dentro ? "entrou-na-sala" : "saiu-da-sala",
      url: window.location.href,
    });
    console.log("[Gravador DM]", dentro ? "Entrou na sala" : "Saiu da sala");
  }
}

// Verifica periodicamente — o Meet usa SPA, entao o DOM muda sem recarregar
const intervalo = setInterval(avisarEstado, 2000);

// Tambem observa mudancas no DOM para reagir mais rapido
const observador = new MutationObserver(() => {
  avisarEstado();
});
observador.observe(document.body, { childList: true, subtree: true });

// Limpa quando a aba e fechada
window.addEventListener("beforeunload", () => {
  clearInterval(intervalo);
  observador.disconnect();
});
