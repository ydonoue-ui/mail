// ===============================
// 予定データ管理
// ===============================
export function loadEvents() {
  return JSON.parse(localStorage.getItem("events") || "[]");
}

export function saveEvents(events) {
  localStorage.setItem("events", JSON.stringify(events));
}

// ===============================
// 直近N日以内の予定を取得（お知らせ機能用）
// ===============================
export function getUpcomingEvents(days = 3) {
  const events = loadEvents();
  const now = new Date();
  const limit = new Date();
  limit.setDate(now.getDate() + days);
  limit.setHours(23, 59, 59, 999);

  return events
    .filter(ev => {
      const d = new Date(ev.datetime);
      return d >= now && d <= limit;
    })
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

// ===============================
// カレンダー状態
// ===============================
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();

// ===============================
// カテゴリごとの色
// ===============================
const COLORS = {
  "面接": "#3E6FA0",
  "締切": "#A63A2E",
  "説明会": "#4F7A5B",
  "インターン": "#A9821F",
  "その他": "#857F70"
};

// ===============================
// カレンダー描画
// ===============================
export function renderCalendar() {
  const calendarDiv = document.getElementById("calendar");
  if (!calendarDiv) return;   // ← これが重要（他ページで暴走しない）

  const events = loadEvents();

  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);

  let html = `
    <h2>${currentYear}年 ${currentMonth + 1}月</h2>
    <button id="prevMonth">← 前の月</button>
    <button id="nextMonth">次の月 →</button>

    <div id="legend">
      <h3>色の意味</h3>
      <div style="color:${COLORS["面接"]}">■ 面接</div>
      <div style="color:${COLORS["締切"]}">■ 締切</div>
      <div style="color:${COLORS["説明会"]}">■ 説明会</div>
      <div style="color:${COLORS["インターン"]}">■ インターン</div>
      <div style="color:${COLORS["その他"]}">■ その他</div>
    </div>

    <table>
      <tr>
        <th>日</th><th>月</th><th>火</th><th>水</th>
        <th>木</th><th>金</th><th>土</th>
      </tr>
  `;

  let day = 1;
  let weekDay = firstDay.getDay();

  html += "<tr>";

  for (let i = 0; i < weekDay; i++) {
    html += "<td></td>";
  }

  while (day <= lastDay.getDate()) {
    const dayEvents = events.filter(ev => {
      const d = new Date(ev.datetime);
      return (
        d.getFullYear() === currentYear &&
        d.getMonth() === currentMonth &&
        d.getDate() === day
      );
    }).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    let cell = `<td onclick="openDetail(${day})"><div class="day-number">${day}</div>`;

    const maxDisplay = 3;
    const displayEvents = dayEvents.slice(0, maxDisplay);

    displayEvents.forEach(ev => {
      cell += `
        <div class="event" style="background:${COLORS[ev.category] || COLORS["その他"]}">
          ${ev.title}
          <button class="delBtn" onclick="event.stopPropagation(); deleteEvent('${ev.id}')">×</button>
        </div>
      `;
    });

    if (dayEvents.length > maxDisplay) {
      const remain = dayEvents.length - maxDisplay;
      cell += `<div style="font-size:12px; color:#666;">+${remain}件</div>`;
    }

    cell += "</td>";
    html += cell;

    if ((weekDay + day) % 7 === 0) {
      html += "</tr><tr>";
    }

    day++;
  }

  html += "</tr></table>";
  calendarDiv.innerHTML = html;

  const prev = document.getElementById("prevMonth");
  const next = document.getElementById("nextMonth");

  prev.onclick = () => {
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }
    renderCalendar();
  };

  next.onclick = () => {
    currentMonth++;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
    renderCalendar();
  };
}

// ===============================
// 詳細ポップアップ
// ===============================
function ensureDayDetailModal() {
  let modal = document.getElementById("dayDetailModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "dayDetailModal";
  modal.className = "day-detail-overlay";
  modal.innerHTML = `
    <div class="day-detail-box">
      <div class="day-detail-header">
        <h3 id="dayDetailTitle"></h3>
        <button type="button" id="dayDetailClose" class="day-detail-close" aria-label="閉じる">×</button>
      </div>
      <div id="dayDetailList" class="day-detail-list"></div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => { modal.style.display = "none"; };
  modal.querySelector("#dayDetailClose").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  return modal;
}

window.openDetail = function(day) {
  const events = loadEvents();

  const dayEvents = events.filter(ev => {
    const d = new Date(ev.datetime);
    return (
      d.getFullYear() === currentYear &&
      d.getMonth() === currentMonth &&
      d.getDate() === day
    );
  }).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (dayEvents.length === 0) return;

  const modal = ensureDayDetailModal();
  modal.querySelector("#dayDetailTitle").textContent = `${currentYear}年${currentMonth + 1}月${day}日の予定`;

  const listEl = modal.querySelector("#dayDetailList");
  listEl.innerHTML = "";

  dayEvents.forEach(ev => {
    const time = new Date(ev.datetime).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit"
    });

    const item = document.createElement("div");
    item.className = "day-detail-item";
    item.innerHTML = `
      <span class="day-detail-category">【${escapeHtmlForDetail(ev.category)}】</span>
      <span class="day-detail-time">${time}〜</span>
      <span class="day-detail-item-title">${escapeHtmlForDetail(ev.title)}</span>
    `;

    // メール解析から自動登録された予定（sourceMailIdあり）はクリックで元メールへ飛べるようにする。
    // 締切イベントは "{gmailId}-deadline" という形でIDを持っているため、元のGmail IDに戻す。
    if (ev.sourceMailId) {
      const mailId = ev.sourceMailId.replace(/-deadline$/, "");
      item.classList.add("day-detail-item-clickable");
      item.title = "クリックでメールを開く";
      item.onclick = () => { location.href = `mail.html?id=${encodeURIComponent(mailId)}`; };
    }

    listEl.appendChild(item);
  });

  modal.style.display = "flex";
};

function escapeHtmlForDetail(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ===============================
// 削除
// ===============================
window.deleteEvent = function(id) {
  let events = loadEvents();
  events = events.filter(ev => ev.id !== id);
  saveEvents(events);
  renderCalendar();
};

// ===============================
// 手動追加
// ===============================
export function initAddForm() {
  const btn = document.getElementById("addBtn");
  if (!btn) return;   // ← 他ページで暴走しない

  btn.onclick = () => {
    const title = document.getElementById("titleInput").value;
    const date = document.getElementById("dateInput").value;
    const time = document.getElementById("timeInput").value;
    const category = document.getElementById("categoryInput").value;

    if (!title || !date) {
      alert("タイトルと日付は必須です");
      return;
    }

    const datetime = new Date(`${date}T${time || "09:00"}`);

    const events = loadEvents();
    events.push({
      id: crypto.randomUUID(),
      title,
      datetime,
      category
    });

    saveEvents(events);
    renderCalendar();
  };
}

// ===============================
// 自動追加（メール解析からの登録）
// 同じメールから重複登録しないよう sourceMailId で重複チェックする
// ===============================
export function addEventAuto(title, datetime, category, sourceMailId = null) {
  const events = loadEvents();

  if (sourceMailId) {
    const existing = events.find(ev => ev.sourceMailId === sourceMailId);
    if (existing) {
      // 内容が変わっていれば更新だけする（二重登録は防ぐ）
      existing.title = title;
      existing.datetime = datetime;
      existing.category = category;
      saveEvents(events);
      return existing;
    }
  }

  const newEvent = {
    id: crypto.randomUUID(),
    title,
    datetime,
    category,
    sourceMailId
  };

  events.push(newEvent);
  saveEvents(events);
  return newEvent;
}

// ===============================
// メール解析からの自動登録を取り消す
// 再分類などでカテゴリ・日時判定が変わり、以前登録した予定が
// もう不要になった場合に、そのゴミ予定をカレンダーから消すために使う
// ===============================
export function removeEventBySourceMailId(sourceMailId) {
  const events = loadEvents();
  const filtered = events.filter(ev => ev.sourceMailId !== sourceMailId);
  if (filtered.length === events.length) return false;
  saveEvents(filtered);
  return true;
}

// ===============================
// 初期化（安全版）
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  renderCalendar();
  initAddForm();
});
