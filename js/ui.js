import { supabase } from "./supabase.js";

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

// ===============================
// メール読み込み（mails.html専用）
// ===============================
async function loadMails() {
  const { data, error } = await supabase.from("mails").select("*");

  if (error) {
    console.error(error);
    return;
  }

  const list = document.getElementById("mailList");
  if (!list) return; // ← mails.html 以外では実行しない

  list.innerHTML = "";

  data.forEach(mail => {
    const div = document.createElement("div");
    div.className = "mail-item";
    div.innerHTML = `
      <h3>${escapeHtml(mail.subject)}</h3>
      <p>${escapeHtml(mail.from_address)}</p>
      <p>カテゴリ: ${escapeHtml(mail.category)}</p>
    `;
    list.appendChild(div);
  });
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
