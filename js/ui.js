// ===============================
// HTMLエスケープ（XSS対策）
// ===============================
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ===============================
// メール読み込み・検索（mails.html専用）
// localStorage（savedMails）だけを見る。外部サービスに一切依存しないので
// Supabase側で障害が起きていてもこの検索機能は必ず動く。
// ===============================
let allMails = [];

function renderMails(mails) {
  const list = document.getElementById("mailList");
  if (!list) return;

  const summary = document.getElementById("searchSummary");
  if (summary) {
    summary.textContent = mails.length === allMails.length
      ? `全${allMails.length}件`
      : `${mails.length}件ヒット（全${allMails.length}件中）`;
  }

  list.innerHTML = "";

  if (mails.length === 0) {
    list.innerHTML = `<p style="color:var(--ink-soft);">該当するメールが見つかりませんでした。</p>`;
    return;
  }

  mails.forEach(mail => {
    const unreadMark = mail.read ? "" : `<span style="color:var(--seal);">●</span> `;
    const div = document.createElement("div");
    div.className = "mail-item";
    div.style.fontWeight = mail.read ? "normal" : "bold";
    div.innerHTML = `
      <h3 style="margin:0 0 6px;">${unreadMark}${escapeHtml(mail.subject)}</h3>
      <p style="margin:0 0 4px; color:var(--ink-soft); font-size:13px;">
        ${escapeHtml(mail.company || mail.from)} ・ ${formatDate(mail.date)}
      </p>
      <p style="margin:0;"><span class="badge format-badge">${escapeHtml(mail.category)}</span></p>
    `;
    div.onclick = () => location.href = `mail.html?id=${mail.id}`;
    list.appendChild(div);
  });
}

function matchesQuery(mail, query) {
  const haystack = [
    mail.company, mail.subject, mail.from, mail.category, mail.body
  ].map(v => (v || "").toLowerCase()).join(" ");
  return query.trim().toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

function loadMails() {
  if (!document.getElementById("mailList")) return; // ← mails.html 以外では実行しない

  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem("savedMails") || "[]");
  } catch (e) {
    console.error("savedMailsの読み込みに失敗しました:", e);
    saved = [];
  }

  allMails = [...saved].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (allMails.length === 0) {
    document.getElementById("mailList").innerHTML =
      `<p style="color:var(--ink-soft);">まだメールが同期されていません。トップページで「今すぐメール同期」を実行してください。</p>`;
    const summary = document.getElementById("searchSummary");
    if (summary) summary.textContent = "";
    return;
  }

  renderMails(allMails);

  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value;
      if (!query.trim()) {
        renderMails(allMails);
      } else {
        renderMails(allMails.filter(m => matchesQuery(m, query)));
      }
    });
  }
}

// ===============================
// 戻るボタン（共通）
// ===============================
export function insertBackButton() {
  if (document.getElementById("backButton")) return;

  const btn = document.createElement("button");
  btn.id = "backButton";
  btn.textContent = "← 戻る";
  btn.style.marginBottom = "10px";
  btn.style.padding = "6px 12px";
  btn.style.fontSize = "14px";
  btn.style.cursor = "pointer";
  btn.onclick = () => history.back();

  document.body.prepend(btn);
}

// ===============================
// グローバル公開
// ===============================
window.insertBackButton = insertBackButton;

// ===============================
// 初期化（mails.html のときだけ）
// ===============================
if (document.getElementById("mailList")) {
  loadMails();
}
