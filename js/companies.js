// ===============================
// 登録企業（ウォッチリスト）機能
// 気になる/選考中の企業を登録して、その企業から来たメールだけを
// 横断的に見れるようにする
// ===============================

const STORAGE_KEY = "trackedCompanies";

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

function getTrackedCompanies() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch (e) {
    console.error(e);
    return [];
  }
}

function saveTrackedCompanies(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function addCompany(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = getTrackedCompanies();
  if (list.some(c => c.toLowerCase() === trimmed.toLowerCase())) return; // 重複防止
  list.push(trimmed);
  saveTrackedCompanies(list);
}

function removeCompany(name) {
  const list = getTrackedCompanies().filter(c => c !== name);
  saveTrackedCompanies(list);
}

function getAllMails() {
  try {
    return JSON.parse(localStorage.getItem("savedMails") || "[]");
  } catch (e) {
    console.error(e);
    return [];
  }
}

// 企業名でメールを絞り込む（企業名・件名・差出人・本文のいずれかに含まれていればヒット）
function findMailsForCompany(companyName, allMails) {
  const needle = companyName.toLowerCase();
  return allMails
    .filter(mail => {
      const haystack = [mail.company, mail.subject, mail.from, mail.body]
        .map(v => (v || "").toLowerCase())
        .join(" ");
      return haystack.includes(needle);
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// ===============================
// 描画
// ===============================
function renderCompanyList() {
  const listEl = document.getElementById("companyList");
  const emptyEl = document.getElementById("companyListEmpty");
  if (!listEl) return;

  const companies = getTrackedCompanies();
  const allMails = getAllMails();

  listEl.innerHTML = "";

  if (companies.length === 0) {
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  companies.forEach(name => {
    const matched = findMailsForCompany(name, allMails);
    const unreadCount = matched.filter(m => !m.read).length;

    const chip = document.createElement("div");
    chip.className = "company-chip";
    chip.innerHTML = `
      <span class="company-chip-name">${escapeHtml(name)}</span>
      <span class="company-chip-count">${matched.length}件${unreadCount > 0 ? `<span class="unread-stamp">${unreadCount}</span>` : ""}</span>
      <button class="company-chip-remove" title="削除" data-name="${escapeHtml(name)}">×</button>
    `;
    chip.querySelector(".company-chip-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`「${name}」を登録から外しますか？`)) {
        removeCompany(name);
        renderCompanyList();
        if (document.getElementById("selectedCompanyLabel")?.dataset.name === name) {
          clearSelection();
        }
      }
    });
    chip.addEventListener("click", () => selectCompany(name));
    listEl.appendChild(chip);
  });
}

function clearSelection() {
  const label = document.getElementById("selectedCompanyLabel");
  const results = document.getElementById("companyMailResults");
  if (label) { label.textContent = "登録した企業をクリックすると、その企業からのメールがここに表示されます"; label.dataset.name = ""; }
  if (results) results.innerHTML = "";
}

function selectCompany(name) {
  const allMails = getAllMails();
  const matched = findMailsForCompany(name, allMails);

  const label = document.getElementById("selectedCompanyLabel");
  const results = document.getElementById("companyMailResults");
  if (!label || !results) return;

  label.textContent = `「${name}」からのメール（${matched.length}件）`;
  label.dataset.name = name;

  results.innerHTML = "";
  if (matched.length === 0) {
    results.innerHTML = `<p style="color:var(--ink-soft);">まだこの企業からのメールは見つかっていません。「今すぐメール同期」を試すか、企業名の表記ゆれ（略称など）を確認してください。</p>`;
    return;
  }

  matched.forEach(mail => {
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
    results.appendChild(div);
  });
}

// ===============================
// 初期化（companies.html のときだけ）
// ===============================
function init() {
  const form = document.getElementById("addCompanyForm");
  if (!form) return;

  renderCompanyList();
  clearSelection();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("companyNameInput");
    addCompany(input.value);
    input.value = "";
    renderCompanyList();
  });
}

if (document.getElementById("addCompanyForm")) {
  init();
}
