/**
 * resultado.js — pagina que exibe a ata gerada renderizada como HTML.
 */

const el = (id) => document.getElementById(id);

let ataAtual = "";

// === Renderizador de Markdown minimo ===
// Cobre o que o Gemini gera: headings, listas, bold, italic, codigo, hr.
function renderMarkdown(texto) {
  const linhas = texto.split("\n");
  const html = [];
  let dentroListaBullet = false;
  let dentroParagrafo = false;

  const fechaParagrafo = () => {
    if (dentroParagrafo) {
      html.push("</p>");
      dentroParagrafo = false;
    }
  };

  const fechaLista = () => {
    if (dentroListaBullet) {
      html.push("</ul>");
      dentroListaBullet = false;
    }
  };

  const inline = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  for (const linhaCrua of linhas) {
    const linha = linhaCrua.trimEnd();

    if (linha === "") {
      fechaParagrafo();
      fechaLista();
      continue;
    }

    if (linha.startsWith("# ")) {
      fechaParagrafo();
      fechaLista();
      html.push(`<h1>${inline(linha.slice(2))}</h1>`);
      continue;
    }
    if (linha.startsWith("## ")) {
      fechaParagrafo();
      fechaLista();
      html.push(`<h2>${inline(linha.slice(3))}</h2>`);
      continue;
    }
    if (linha.startsWith("### ")) {
      fechaParagrafo();
      fechaLista();
      html.push(`<h3>${inline(linha.slice(4))}</h3>`);
      continue;
    }
    if (linha === "---" || linha === "***") {
      fechaParagrafo();
      fechaLista();
      html.push("<hr>");
      continue;
    }
    if (linha.startsWith("- ") || linha.startsWith("* ")) {
      fechaParagrafo();
      if (!dentroListaBullet) {
        html.push("<ul>");
        dentroListaBullet = true;
      }
      html.push(`<li>${inline(linha.slice(2))}</li>`);
      continue;
    }
    // Linha normal — paragrafo
    fechaLista();
    if (!dentroParagrafo) {
      html.push("<p>");
      dentroParagrafo = true;
      html.push(inline(linha));
    } else {
      html.push("<br>" + inline(linha));
    }
  }
  fechaParagrafo();
  fechaLista();

  return html.join("\n");
}

// === Toast de feedback ===
function mostrarToast(texto, ms = 2000) {
  const t = el("toast");
  t.textContent = texto;
  t.classList.remove("oculto");
  setTimeout(() => t.classList.add("oculto"), ms);
}

// === Carregar ata do storage ===
async function carregarAta() {
  const { ultima_ata } = await chrome.storage.local.get("ultima_ata");
  if (!ultima_ata || !ultima_ata.texto) {
    return;
  }
  ataAtual = ultima_ata.texto;

  el("conteudo").innerHTML = renderMarkdown(ataAtual);

  const data = new Date(ultima_ata.quando);
  el("data-geracao").textContent = `Gerada em ${data.toLocaleString("pt-BR")}`;

  el("rodape-versao").textContent = "v" + chrome.runtime.getManifest().version;
}

// === Acoes ===
el("btn-copiar").addEventListener("click", async () => {
  if (!ataAtual) return;
  try {
    await navigator.clipboard.writeText(ataAtual);
    mostrarToast("Texto copiado!");
  } catch (e) {
    mostrarToast("Falha ao copiar: " + e.message, 3000);
  }
});

el("btn-baixar").addEventListener("click", () => {
  if (!ataAtual) return;
  const blob = new Blob([ataAtual], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const agora = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  a.download = `ata_${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  mostrarToast("Download iniciado");
});

// Atualiza se o storage mudar (ata regerada em outra janela)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.ultima_ata) carregarAta();
});

carregarAta();
