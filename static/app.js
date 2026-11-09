"use strict";

const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

const chatEl = document.getElementById("chat");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const modelEl = document.getElementById("model");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");

let busy = false;

/* ---------- Utilidades ---------- */

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scrollDown() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setStatus(text, mode) {
  statusTextEl.textContent = text;
  statusEl.classList.toggle("busy", mode === "busy");
}

/* ---------- Renderizado de markdown (subconjunto) ---------- */

function renderInline(s) {
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

function splitTableRow(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function renderMarkdown(text) {
  const lines = text.split("\n");
  const out = [];
  let tableRows = [];
  let inCode = false;
  let codeBuf = [];
  let listKind = null;

  const flushTable = () => {
    if (!tableRows.length) return;
    let t = "<table>";
    tableRows.forEach((cells, i) => {
      const tag = i === 0 ? "th" : "td";
      t += "<tr>";
      cells.forEach((c) => { t += `<${tag}>${renderInline(c)}</${tag}>`; });
      t += "</tr>";
    });
    t += "</table>";
    out.push(t);
    tableRows = [];
  };

  const closeList = () => {
    if (listKind) { out.push(listKind === "ol" ? "</ol>" : "</ul>"); listKind = null; }
  };

  for (const raw of lines) {
    const line = raw;

    if (/^```/.test(line.trim())) {
      flushTable(); closeList();
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // Tabla
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      const cells = splitTableRow(line);
      const isSep = cells.every((c) => /^:?-+:?$/.test(c));
      if (isSep) continue;
      tableRows.push(cells);
      continue;
    } else {
      flushTable();
    }

    // Encabezados
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      continue;
    }

    // Listas
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ol ? "ol" : "ul";
      if (listKind !== kind) { closeList(); out.push(kind === "ol" ? "<ol>" : "<ul>"); listKind = kind; }
      out.push(`<li>${renderInline((ul || ol)[1])}</li>`);
      continue;
    } else {
      closeList();
    }

    if (line.trim() === "") continue;

    out.push(`<p>${renderInline(line)}</p>`);
  }

  flushTable();
  closeList();
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);

  return out.join("\n");
}

/* ---------- Mensajes ---------- */

function appendUser(text) {
  const msg = document.createElement("div");
  msg.className = "msg user";
  msg.innerHTML = '<div class="who">T&Uacute; &rsaquo;</div><div class="body"></div>';
  msg.querySelector(".body").textContent = text;
  chatEl.appendChild(msg);
  scrollDown();
}

function appendAssistant() {
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  msg.innerHTML =
    '<div class="who">ASISTENTE &rsaquo;</div><div class="body"></div><span class="cursor"></span>';
  const body = msg.querySelector(".body");
  const cursor = msg.querySelector(".cursor");
  chatEl.appendChild(msg);
  scrollDown();

  return {
    el: msg,
    raw: "",
    appendDelta(delta) {
      this.raw += delta;
      body.innerHTML = renderMarkdown(this.raw);
      scrollDown();
    },
    showError(message) {
      this.el.classList.add("error");
      body.innerHTML = `<span class="err">⚠ ${escapeHtml(message)}</span>`;
      cursor.remove();
      scrollDown();
    },
    finish() {
      body.innerHTML = renderMarkdown(this.raw);
      cursor.remove();
      this.el.classList.add("done");
      scrollDown();
    },
  };
}

/* ---------- Envío y streaming ---------- */

async function sendQuestion(question) {
  if (busy || !question.trim()) return;
  busy = true;
  sendEl.disabled = true;
  setStatus("PROCESANDO…", "busy");

  const model = modelEl.value.trim() || DEFAULT_MODEL;
  appendUser(question);
  const bubble = appendAssistant();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, model }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let data;
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (data.type === "delta") {
            bubble.appendDelta(data.content);
          } else if (data.type === "error") {
            bubble.showError(data.message);
          }
        }
      }
    }
    bubble.finish();
  } catch (err) {
    bubble.showError(err.message || String(err));
  } finally {
    busy = false;
    sendEl.disabled = false;
    setStatus("EN LÍNEA", "ok");
    promptEl.focus();
  }
}

/* ---------- Eventos ---------- */

function autoGrow() {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 160) + "px";
}

sendEl.addEventListener("click", () => {
  const q = promptEl.value;
  promptEl.value = "";
  autoGrow();
  sendQuestion(q);
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const q = promptEl.value;
    promptEl.value = "";
    autoGrow();
    sendQuestion(q);
  }
});

promptEl.addEventListener("input", autoGrow);

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    promptEl.value = chip.dataset.q;
    autoGrow();
    sendQuestion(chip.dataset.q);
  });
});

/* ---------- Arranque ---------- */

(function welcome() {
  const msg = document.createElement("div");
  msg.className = "msg assistant done";
  msg.innerHTML =
    '<div class="who">ASISTENTE &rsaquo;</div>' +
    '<div class="body">' +
    "<p>Sistema conectado. Soy tu analista de ventas sobre la base <strong>sales_data.db</strong>.</p>" +
    "<p>Pregunta por tiendas, SKUs, fechas o promociones y consultar&eacute; los datos por ti.</p>" +
    "</div>";
  chatEl.appendChild(msg);
})();

promptEl.focus();
