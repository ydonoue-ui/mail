import { supabase } from "./supabase.js";
import { updateLoginUI } from "./auth.js";
import { addEventAuto } from "./calendar.js";

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
// Googleログイン
// ===============================
export async function loginWithGoogle() {
  const provider = google.accounts.oauth2.initTokenClient({
    client_id: "740838490341-lbk668eejtimanj49ck246dvcd6kr0ga.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    callback: (tokenResponse) => {
      localStorage.setItem("gmailToken", tokenResponse.access_token);
      alert("ログイン成功！");
      updateLoginUI();
    }
  });

  provider.requestAccessToken();
}

// ===============================
// Gmail API でメール同期
// ===============================
export async function syncMails() {
  const token = localStorage.getItem("gmailToken");
  if (!token) {
    alert("Googleログインしてください");
    return;
  }

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const data = await res.json();
  if (!data.messages) return;

  // 既存データ（既読状態などを引き継ぐため）
  const existingMails = JSON.parse(localStorage.getItem("savedMails") || "[]");
  const existingMap = new Map(existingMails.map(m => [m.id, m]));

  const mails = [];

  for (const msg of data.messages) {
    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const detailData = await detailRes.json();

    const headers = detailData.payload.headers;
    const subject = headers.find(h => h.name === "Subject")?.value || "";
    const fromHeader = headers.find(h => h.name === "From")?.value || "";
    const body = extractBody(detailData.payload);

    const internalDate = detailData.internalDate;
    const receivedDate = new Date(Number(internalDate));
    const date = receivedDate.toISOString();

    const fullText = normalizeText(subject + "\n" + body);

    const company = extractCompany(fromHeader, body);
    const categoryResult = detectCategory(fullText);
    const category = categoryResult.category;

    const format = detectFormat(fullText);

    // 本文中の日時候補をすべて拾い、目的別に振り分ける
    const allDates = extractAllDateTimes(fullText, receivedDate);
    const eventInfo = pickEventDate(allDates, fullText, category, receivedDate);
    const deadlineInfo = pickDeadlineDate(allDates, fullText, receivedDate);

    const existing = existingMap.get(msg.id);

    const mailObj = {
      id: msg.id,
      subject,
      from: fromHeader,
      company,
      body,
      category,
      categoryScore: categoryResult.score,
      format,
      date,
      eventDate: eventInfo ? eventInfo.date.toISOString() : null,
      eventDateConfidence: eventInfo ? eventInfo.confidence : null,
      candidateDates: allDates.map(d => d.date.toISOString()),
      deadlineDate: deadlineInfo ? deadlineInfo.date.toISOString() : null,
      read: existing ? !!existing.read : false
    };

    mails.push(mailObj);

    await saveMail(mailObj);

    // --- カレンダー自動登録：本イベント ---
    const calendarCategory = mapToCalendarCategory(category);
    if (eventInfo && calendarCategory) {
      const title = `${company || "(企業名不明)"} ${shortenCategory(category)}${format ? `（${format}）` : ""}`;
      addEventAuto(title, eventInfo.date, calendarCategory, msg.id);
    }

    // --- カレンダー自動登録：返信・提出締切（本イベントと別日付の場合のみ）---
    if (deadlineInfo && (!eventInfo || Math.abs(deadlineInfo.date - eventInfo.date) > 1000 * 60 * 60 * 24)) {
      const deadlineTitle = `${company || "(企業名不明)"} 締切（${shortenCategory(category)}）`;
      addEventAuto(deadlineTitle, deadlineInfo.date, "締切", `${msg.id}-deadline`);
    }
  }

  localStorage.setItem("savedMails", JSON.stringify(mails));
  alert("メール同期完了！");
}

// ===============================
// 本文抽出（ネストされたmultipartにも対応）
// ===============================
function extractBody(payload) {
  if (!payload.parts) {
    if (payload.body?.data) return decodeBase64(payload.body.data);
    return "";
  }

  const findPart = (parts, mimeType) => {
    for (const p of parts) {
      if (p.mimeType === mimeType && p.body?.data) return p.body.data;
      if (p.parts) {
        const nested = findPart(p.parts, mimeType);
        if (nested) return nested;
      }
    }
    return null;
  };

  // text/plain を優先、無ければ text/html からタグを除去して使う
  let data = findPart(payload.parts, "text/plain");
  if (data) return decodeBase64(data);

  data = findPart(payload.parts, "text/html");
  if (data) {
    const html = decodeBase64(data);
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  return "";
}

function decodeBase64(str) {
  try {
    return decodeURIComponent(escape(atob(str.replace(/-/g, "+").replace(/_/g, "/"))));
  } catch (e) {
    return "";
  }
}

// ===============================
// テキスト正規化
// 全角数字→半角、漢数字の日付表現→算用数字 など、
// 表記ゆれを吸収して以降の抽出精度を上げる
// ===============================
function normalizeText(text) {
  if (!text) return "";

  // 全角数字 → 半角数字
  let t = text.replace(/[０-９]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );

  // 全角コロン・チルダ・スラッシュ → 半角
  t = t
    .replace(/：/g, ":")
    .replace(/〜|～/g, "~")
    .replace(/／/g, "/")
    .replace(/　/g, " ");

  // 漢数字（一〜三十一）を算用数字に変換（日付の「日」「月」直前のみ対象）
  const kanjiNums = {
    "十一": 11, "十二": 12, "十三": 13, "十四": 14, "十五": 15,
    "十六": 16, "十七": 17, "十八": 18, "十九": 19,
    "二十一": 21, "二十二": 22, "二十三": 23, "二十四": 24, "二十五": 25,
    "二十六": 26, "二十七": 27, "二十八": 28, "二十九": 29,
    "三十一": 31, "三十": 30, "二十": 20, "十": 10,
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9
  };
  // 長い表記から先にマッチさせるためキー長でソート
  const sortedKeys = Object.keys(kanjiNums).sort((a, b) => b.length - a.length);
  const kanjiPattern = new RegExp(`(${sortedKeys.join("|")})(?=[月日])`, "g");
  t = t.replace(kanjiPattern, match => String(kanjiNums[match]));

  return t;
}

// ===============================
// 企業名の抽出
// 1. Fromヘッダーの表示名から（肩書き除去）
// 2. 取れない/メーラー名等で不適切な場合は本文の署名（"株式会社〇〇"等）から拾う
// ===============================
function extractCompany(fromHeader, body) {
  let name = "";

  if (fromHeader) {
    const match = fromHeader.match(/^"?([^"<]+)"?\s*<[^>]+>/);
    name = match ? match[1].trim() : fromHeader.replace(/<[^>]+>/, "").trim();

    name = name.replace(
      /(採用担当|採用チーム|人事部|人事課|新卒採用担当|キャリア採用|リクルーティングチーム|採用窓口|事務局|採用グループ|人事グループ)\s*$/,
      ""
    ).trim();
  }

  const looksInvalid =
    !name ||
    /^(no-?reply|info|mailer|support|notification|system)/i.test(name) ||
    /@/.test(name);

  if (looksInvalid && body) {
    // 本文署名から「株式会社」「合同会社」等を含む行を探す
    const sigMatch = body.match(
      /(株式会社[^\s\n　、。]{1,20}|[^\s\n　、。]{1,20}株式会社|合同会社[^\s\n　、。]{1,20}|[^\s\n　、。]{1,20}合同会社)/
    );
    if (sigMatch) return sigMatch[1];
  }

  return name;
}

// ===============================
// 選考フォーマット（対面/オンライン）の検出
// ===============================
function detectFormat(text) {
  const online = /(Zoom|Teams|Google\s?Meet|オンライン|Web面接|ウェブ面接|オンライン開催)/i.test(text);
  const offline = /(対面|来社|本社にて|弊社オフィス|会場にて)/.test(text);

  if (online && offline) return "対面/オンライン選択可";
  if (online) return "オンライン";
  if (offline) return "対面";
  return "";
}

// ===============================
// 日時抽出（本文中に出てくる候補をすべて拾う）
// 対応パターン:
//  - 2026年6月15日 / 6月15日 / 6/15
//  - 日付の直後・直前にある 13:00 / 13時 / 13時00分
//  - 「13:00~14:00」のような範囲は開始時刻を採用
// ===============================
function extractAllDateTimes(text, baseDate) {
  const results = [];

  const dateRegex = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日|(\d{1,2})\/(\d{1,2})(?!\d)/g;
  let m;

  while ((m = dateRegex.exec(text)) !== null) {
    let year = m[1] ? Number(m[1]) : null;
    let month = m[2] ? Number(m[2]) : Number(m[4]);
    let day = m[2] ? Number(m[3]) : Number(m[5]);

    if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) continue;

    // 日付の後ろ40文字以内にある最初の時刻を探す（範囲指定なら開始時刻）
    const tail = text.slice(m.index, m.index + 60);
    const timeMatch = tail.match(/(\d{1,2}):(\d{2})|(\d{1,2})時(?:(\d{1,2})分)?/);

    let hour = 9, minute = 0, hasTime = false;
    if (timeMatch) {
      hasTime = true;
      if (timeMatch[1] !== undefined) {
        hour = Number(timeMatch[1]);
        minute = Number(timeMatch[2]);
      } else {
        hour = Number(timeMatch[3]);
        minute = timeMatch[4] ? Number(timeMatch[4]) : 0;
      }
    }

    if (hour > 23 || minute > 59) continue;

    let useYear = year || baseDate.getFullYear();
    let candidate = new Date(useYear, month - 1, day, hour, minute);

    // 年指定が無く、受信日より大幅に過去なら来年の予定とみなす
    if (!year) {
      const diffDays = (candidate - baseDate) / (1000 * 60 * 60 * 24);
      if (diffDays < -60) {
        candidate = new Date(useYear + 1, month - 1, day, hour, minute);
      }
    }

    results.push({
      date: candidate,
      hasTime,
      index: m.index,
      contextBefore: text.slice(Math.max(0, m.index - 15), m.index),
      contextAfter: text.slice(m.index, m.index + 30)
    });
  }

  // 重複（同一日時）を除去
  const seen = new Set();
  return results.filter(r => {
    const key = r.date.getTime();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===============================
// 抽出した候補から「本イベント日時」を1つ選ぶ
// 優先順位:
//  1. 「締切」「〆切」関連の文脈にある日付は除外
//  2. 時刻情報を伴う日付を優先
//  3. 受信日以降で最も近い未来日を優先（無ければ最初の候補）
// ===============================
function pickEventDate(candidates, text, category, baseDate) {
  if (candidates.length === 0) return null;

  const deadlineWords = /(締切|締め切り|〆切|まで.{0,5}(ご返信|ご回答|お申し込み|提出))/;

  const nonDeadline = candidates.filter(c => {
    const around = text.slice(Math.max(0, c.index - 20), c.index + 20);
    return !deadlineWords.test(around);
  });

  const pool = nonDeadline.length > 0 ? nonDeadline : candidates;

  const withTime = pool.filter(c => c.hasTime);
  const targetPool = withTime.length > 0 ? withTime : pool;

  const future = targetPool.filter(c => c.date >= baseDate);
  const chosen = (future.length > 0 ? future : targetPool)
    .sort((a, b) => a.date - b.date)[0];

  if (!chosen) return null;

  const confidence = chosen.hasTime ? "high" : "medium";
  return { date: chosen.date, confidence };
}

// ===============================
// 締切日時を選ぶ（「締切」「〆切」等の文脈に最も近い候補）
// ===============================
function pickDeadlineDate(candidates, text, baseDate) {
  if (candidates.length === 0) return null;

  const deadlineWords = /(締切|締め切り|〆切|まで.{0,5}(ご返信|ご回答|お申し込み|提出))/g;
  const deadlinePositions = [];
  let m;
  while ((m = deadlineWords.exec(text)) !== null) {
    deadlinePositions.push(m.index);
  }

  if (deadlinePositions.length === 0) return null;

  // 締切ワードに最も近い日付候補を選ぶ
  let best = null;
  let bestDist = Infinity;

  candidates.forEach(c => {
    deadlinePositions.forEach(pos => {
      const dist = Math.abs(c.index - pos);
      if (dist < bestDist && dist < 80) {
        bestDist = dist;
        best = c;
      }
    });
  });

  if (!best) return null;
  return { date: best.date };
}

// ===============================
// メールのカテゴリ → カレンダーの色分類への変換
// ===============================
function mapToCalendarCategory(category) {
  const map = {
    "面接案内": "面接",
    "面接日程調整": "面接",
    "説明会案内": "説明会",
    "インターン案内": "インターン",
    "座談会案内": "説明会",
    "イベント案内": "説明会",
    "締切案内": "締切",
    "エントリー案内": "締切",
    "適性検査・WEBテスト": "締切",
    "課題提出": "締切"
  };
  return map[category] || null;
}

function shortenCategory(category) {
  return category.replace(/案内|・WEBテスト/g, "");
}

// ===============================
// 就活関連メールかどうかの判定（誤判定防止の関所）
// 「合格」「通過」のような単語だけでは抽選・資格試験など別物の
// メールにも反応してしまうため、就活特有の文脈語が一定数含まれて
// いるメールだけをカテゴリ分類の対象にする。
// ===============================
const JOB_CONTEXT_PATTERNS = [
  /採用/, /選考/, /応募/, /エントリーシート|^ES |[^A-Za-z]ES[^A-Za-z]/,
  /就職活動|就活/, /新卒採用|中途採用/, /本選考/, /インターンシップ|インターン/,
  /貴社|弊社/, /マイページ/, /説明会/, /面接/, /内定/, /人事部|人事課/,
  /キャリア採用/, /採用担当/, /履歴書|職務経歴書/, /募集要項/
];

function isJobRelated(text) {
  let hits = 0;
  for (const re of JOB_CONTEXT_PATTERNS) {
    if (re.test(text)) hits++;
    if (hits >= 1) return true; // どれか1つでも就活特有の語があればOK
  }
  return false;
}

// ===============================
// カテゴリ分類ロジック（スコアリング方式）
// 各カテゴリにキーワード・重みを設定し、合計点が最も高いカテゴリを採用する。
// 否定的なキーワード（不通過・不採用）はボーナス点で優先される。
// ===============================
const CATEGORY_RULES = [
  {
    category: "不通過",
    patterns: [
      { re: /不通過/, weight: 10 },
      { re: /見送り(?!.*面接)/, weight: 6 },
      { re: /今回はご期待に沿えな/, weight: 8 }
    ]
  },
  {
    category: "不採用",
    patterns: [
      { re: /不採用/, weight: 10 },
      { re: /採用を見送/, weight: 8 },
      { re: /誠に残念ながら.{0,15}(採用|選考)/, weight: 6 }
    ]
  },
  {
    category: "面接日程調整",
    patterns: [
      { re: /面接.{0,10}(日程|候補日|ご都合)/, weight: 9 },
      { re: /(日程|候補日).{0,10}面接/, weight: 9 },
      { re: /面接希望日/, weight: 8 },
      { re: /面接.{0,15}調整/, weight: 7 }
    ]
  },
  {
    category: "面接案内",
    patterns: [
      { re: /面接/, weight: 5 },
      { re: /最終面接/, weight: 6 },
      { re: /一次面接|二次面接|三次面接/, weight: 6 }
    ]
  },
  {
    category: "説明会案内",
    patterns: [
      { re: /会社説明会/, weight: 8 },
      { re: /説明会/, weight: 6 }
    ]
  },
  {
    category: "インターン案内",
    patterns: [
      { re: /インターンシップ/, weight: 8 },
      { re: /インターン/, weight: 6 }
    ]
  },
  {
    category: "座談会案内",
    patterns: [{ re: /座談会/, weight: 7 }]
  },
  {
    category: "適性検査・WEBテスト",
    patterns: [
      { re: /WEBテスト|Webテスト/i, weight: 8 },
      { re: /適性検査/, weight: 8 },
      { re: /SPI/, weight: 7 },
      { re: /玉手箱/, weight: 7 }
    ]
  },
  {
    category: "課題提出",
    patterns: [
      { re: /課題.{0,10}(提出|ご提出)/, weight: 8 },
      { re: /レポート提出|ワーク提出/, weight: 7 }
    ]
  },
  {
    category: "選考優遇案内",
    patterns: [{ re: /優遇/, weight: 6 }]
  },
  {
    category: "締切案内",
    patterns: [
      { re: /締切|締め切り|〆切/, weight: 5 }
    ]
  },
  {
    category: "エントリー案内",
    patterns: [
      { re: /エントリー/, weight: 5 },
      { re: /応募受付/, weight: 5 }
    ]
  },
  {
    category: "書類選考通過",
    patterns: [
      { re: /書類選考.{0,10}通過/, weight: 9 },
      { re: /選考.{0,10}通過/, weight: 7 },
      { re: /(?<!不)通過/, weight: 4 }
    ]
  },
  {
    category: "合格・内定",
    patterns: [
      { re: /内定/, weight: 9 },
      { re: /(?<!不)合格/, weight: 7 },
      { re: /採用通知/, weight: 8 }
    ]
  },
  {
    category: "イベント案内",
    patterns: [{ re: /イベント/, weight: 4 }]
  },
  {
    category: "要返信",
    patterns: [
      { re: /ご返信|お返事/, weight: 4 },
      { re: /ご回答をお願い/, weight: 4 }
    ]
  }
];

function detectCategory(text) {
  // 就活と無関係なメールはここで弾く（最大の誤判定要因だったため）
  if (!isJobRelated(text)) {
    return { category: "その他", score: 0 };
  }

  let bestCategory = "その他";
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    rule.patterns.forEach(p => {
      if (p.re.test(text)) score += p.weight;
    });
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
    }
  }

  // スコアが低すぎる場合は誤判定の可能性が高いので「その他」に落とす
  const MIN_SCORE_THRESHOLD = 5;
  if (bestScore < MIN_SCORE_THRESHOLD) {
    return { category: "その他", score: bestScore };
  }

  return { category: bestCategory, score: bestScore };
}

// ===============================
// Supabase 保存（同じメールは上書き保存）
// ===============================
export async function saveMail(mail) {
  const { error } = await supabase.from("mails").upsert(
    [
      {
        gmail_id: mail.id,
        subject: mail.subject,
        from_address: mail.from,
        company: mail.company,
        body: mail.body,
        category: mail.category,
        format: mail.format,
        date: mail.date,
        event_date: mail.eventDate,
        deadline_date: mail.deadlineDate,
        read: mail.read
      }
    ],
    { onConflict: "gmail_id" }
  );

  if (error) console.error(error);
}

// ===============================
// 既読にする
// ===============================
export async function markAsRead(id) {
  const mails = JSON.parse(localStorage.getItem("savedMails") || "[]");
  const target = mails.find(m => m.id === id);
  if (!target || target.read) return target;

  target.read = true;
  localStorage.setItem("savedMails", JSON.stringify(mails));

  const { error } = await supabase
    .from("mails")
    .update({ read: true })
    .eq("gmail_id", id);

  if (error) console.error(error);

  return target;
}

export function getMailById(id) {
  const mails = JSON.parse(localStorage.getItem("savedMails") || "[]");
  return mails.find(m => m.id === id) || null;
}

// ===============================
// メール一覧を1行描画する共通処理（未読は太字＋●表示）
// ===============================
function renderMailRowHtml(mail) {
  const unreadMark = mail.read ? "" : `<span style="color:#E24A4A;">●</span> `;
  const weight = mail.read ? "normal" : "bold";
  return { unreadMark, weight };
}

function goToMail(id) {
  location.href = `mail.html?id=${encodeURIComponent(id)}`;
}

// ===============================
// 今日のメールだけ表示
// ===============================
export function loadTodayMails() {
  const saved = localStorage.getItem("savedMails");
  if (!saved) return;

  const mails = JSON.parse(saved);
  const today = new Date().toISOString().slice(0, 10);

  const todayMails = mails.filter(mail => mail.date?.startsWith(today));

  const list = document.getElementById("todayMailList");
  list.innerHTML = "";

  todayMails.forEach(mail => {
    const { unreadMark, weight } = renderMailRowHtml(mail);
    const div = document.createElement("div");
    div.style.cursor = "pointer";
    div.style.fontWeight = weight;
    div.innerHTML = `
      ${unreadMark}<strong>${escapeHtml(mail.subject)}</strong><br>
      ${escapeHtml(mail.company || mail.from)}<br>
      <small>${escapeHtml(mail.date)}</small>
    `;
    div.onclick = () => goToMail(mail.id);
    list.appendChild(div);
  });
}

// ===============================
// フォルダー別メール読み込み
// ===============================
export function loadFolderMails(category) {
  const saved = localStorage.getItem("savedMails");
  if (!saved) return;

  const mails = JSON.parse(saved);
  const filtered = mails.filter(m => m.category === category);

  const list = document.getElementById("folderList");
  list.innerHTML = "";

  filtered.forEach(mail => {
    const { unreadMark, weight } = renderMailRowHtml(mail);
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.style.fontWeight = weight;
    tr.innerHTML = `
      <td>${escapeHtml(mail.company || mail.from)}</td>
      <td>${unreadMark}${escapeHtml(mail.subject)}</td>
      <td>${escapeHtml(mail.category)}</td>
    `;
    tr.onclick = () => goToMail(mail.id);
    list.appendChild(tr);
  });
}

// ===============================
// フォルダー件数取得（未読件数も返す）
// ===============================
export function getFolderCounts() {
  const saved = localStorage.getItem("savedMails");
  if (!saved) return {};

  const mails = JSON.parse(saved);
  const counts = {};

  mails.forEach(mail => {
    if (!counts[mail.category]) counts[mail.category] = { total: 0, unread: 0 };
    counts[mail.category].total++;
    if (!mail.read) counts[mail.category].unread++;
  });

  return counts;
}

// ===============================
// グローバル公開
// ===============================
window.loginWithGoogle = loginWithGoogle;
window.syncMails = syncMails;
window.loadTodayMails = loadTodayMails;
window.loadFolderMails = loadFolderMails;
window.getFolderCounts = getFolderCounts;
