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
  "面接": "#4A90E2",
  "締切": "#E24A4A",
  "説明会": "#4AE26F",
  "インターン": "#E2D84A",
  "その他": "#888"
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
    });

    let cell = `<td onclick="openDetail(${day})"><div>${day}</div>`;

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
window.openDetail = function(day) {
  const events = loadEvents();

  const dayEvents = events.filter(ev => {
    const d = new Date(ev.datetime);
    return (
      d.getFullYear() === currentYear &&
      d.getMonth() === currentMonth &&
      d.getDate() === day
    );
  });

  if (dayEvents.length === 0) return;

  let msg = `${currentYear}年${currentMonth + 1}月${day}日の予定\n\n`;

  dayEvents.forEach(ev => {
    const time = new Date(ev.datetime).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit"
    });

    msg += `【${ev.category}】\n`;
    msg += `${time}〜 ${ev.title}\n\n`;
  });

  alert(msg);
};

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
// 初期化（安全版）
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  renderCalendar();
  initAddForm();
});
