import { supabase } from "./supabase.js";
import { updateLoginUI } from "./auth.js";
import { addEventAuto } from "./calendar.js";

// ===============================
// 同時実行数を制限した並列処理
// Gmail APIのレート制限に配慮しつつ、直列より大幅に高速化する
// ===============================
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}

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
// 受信日時の表示用フォーマット
// ===============================
function formatMailDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ===============================
// Googleログイン
// ===============================
export async function loginWithGoogle() {
  const provider = google.accounts.oauth2.initTokenClient({
    client_id: "740838490341-lbk668eejtimanj49ck246dvcd6kr0ga.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    callback: async (tokenResponse) => {
      localStorage.setItem("gmailToken", tokenResponse.access_token);

      // 前回ログインしてたアカウントと違う場合、古いアカウントのデータが残らないようクリアする
      try {
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
        });
        const profile = await res.json();
        const currentEmail = profile.emailAddress;
        const lastEmail = localStorage.getItem("loggedInAccount");

        if (currentEmail && lastEmail && currentEmail !== lastEmail) {
          localStorage.removeItem("savedMails");
          localStorage.removeItem("lastSyncedAt");
          localStorage.removeItem("lastSyncedMaxDate");
          alert(`前回ログインしてた ${lastEmail} とは別のアカウント（${currentEmail}）でログインしました。\n古いアカウントのメールデータは削除したので、「今すぐメール同期」でこのアカウントのメールを取得し直してください。`);
        } else {
          alert("ログイン成功！");
        }
        if (currentEmail) localStorage.setItem("loggedInAccount", currentEmail);
      } catch (e) {
        console.error("アカウント確認に失敗しました:", e);
        alert("ログイン成功！");
      }

      updateLoginUI();
    }
  });
  provider.requestAccessToken();
}

// ===============================
// テキスト正規化
// 全角数字・漢数字・記号を半角に統一して抽出精度を上げる
// ===============================
function normalizeText(text) {
  if (!text) return "";
  let t = text.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  t = t.replace(/：/g, ":").replace(/〜|～/g, "~").replace(/／/g, "/").replace(/　/g, " ");
  const kanjiNums = {
    "十一": 11, "十二": 12, "十三": 13, "十四": 14, "十五": 15,
    "十六": 16, "十七": 17, "十八": 18, "十九": 19,
    "二十一": 21, "二十二": 22, "二十三": 23, "二十四": 24, "二十五": 25,
    "二十六": 26, "二十七": 27, "二十八": 28, "二十九": 29,
    "三十一": 31, "三十": 30, "二十": 20, "十": 10,
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9
  };
  const sortedKeys = Object.keys(kanjiNums).sort((a, b) => b.length - a.length);
  t = t.replace(new RegExp(`(${sortedKeys.join("|")})(?=[月日])`, "g"), m => String(kanjiNums[m]));
  return t;
}

// ===============================
// 就活関連メールかどうかの判定
// ===============================
const JOB_CONTEXT_PATTERNS = [
  /採用/, /選考/, /応募/, /エントリーシート/,
  /就職活動|就活/, /新卒採用|中途採用/, /本選考/,
  /インターンシップ|インターン/, /貴社|弊社/, /マイページ/,
  /説明会/, /面接/, /内定/, /人事部|人事課/,
  /キャリア採用/, /採用担当/, /履歴書|職務経歴書/,
  /募集要項/, /OB訪問|OG訪問/, /求人/, /選考結果/,
  /面談/, /ジョブマッチング|逆求人/,
  /マイナビ|リクナビ|キャリタス|ワンキャリア|dodaキャンパス/i,
  /就活生/, /新卒/, /早期選考/, /就職支援|キャリアセンター/,
  /ES(?!S)/, /会社説明/, /座談会/, /プレエントリー/,
  /適性検査|WEBテスト|Webテスト/i, /玉手箱|SPI/
];

// 就活以外の文脈で誤ヒットしやすい語（複数マッチした場合は弾く）
const NON_JOB_DISTRACTOR_PATTERNS = [
  /資格試験|国家試験|司法試験|検定試験/,
  /抽選|懸賞|当選しました|キャンペーン.{0,10}(プレゼント|当選)/,
  /Quoraダイジェスト|からの回答|もっと読む:/
];

// 大学の学生ポータル（UNIPA等）からの事務連絡に特有のマーカー。
// 「不採用」「応募」など就活っぽい単語が偶然含まれていても、
// これらが複数マッチする場合は大学事務からの掲示（奨学金・履修登録など）である可能性が非常に高いので、
// contextHitsの数に関わらず就活メールとして扱わない。
const UNIVERSITY_PORTAL_PATTERNS = [
  /UNIPA/i,
  /掲示差出人/,
  /学生センター/,
  /奨学金/,
  /学業基準/,
  /履修登録|授業料|休学|復学|奨学生/
];

function isJobRelated(text) {
  const distractorHits = NON_JOB_DISTRACTOR_PATTERNS.filter(re => re.test(text)).length;
  const contextHits = JOB_CONTEXT_PATTERNS.filter(re => re.test(text)).length;
  if (distractorHits > 0 && contextHits <= 1) return false;

  const portalHits = UNIVERSITY_PORTAL_PATTERNS.filter(re => re.test(text)).length;
  if (portalHits >= 2) return false;

  return contextHits >= 1;
}

// ===============================
// カテゴリ分類（スコアリング方式）
// ===============================
const CATEGORY_RULES = [
  {
    category: "不通過",
    patterns: [
      { re: /不通過/, weight: 10 },
      { re: /見送り(?!.*面接)/, weight: 6 },
      { re: /今回はご期待に沿えな/, weight: 8 },
      { re: /選考.{0,15}見送/, weight: 7 },
      { re: /書類.{0,10}(不合格|見送)/, weight: 8 },
      { re: /書類選考.{0,10}(通過できません|通過されませんでした)/, weight: 9 },
      { re: /書類選考の結果.{0,20}(見送|辞退|残念)/, weight: 8 },
      { re: /今回のご縁については/, weight: 7 },
      { re: /誠に勝手ながら.{0,15}見送/, weight: 7 },
      { re: /合格には至りませんでした/, weight: 8 },
      { re: /書類による選考.{0,15}(見送|通過致しかね)/, weight: 8 },
      { re: /大変恐縮ではございますが.{0,20}見送/, weight: 6 }
    ]
  },
  {
    category: "不採用",
    patterns: [
      { re: /不採用/, weight: 10 },
      { re: /採用を見送/, weight: 8 },
      { re: /誠に残念ながら.{0,15}(採用|選考)/, weight: 6 },
      { re: /今後のご活躍をお祈り/, weight: 5 },
      { re: /採用には至りません/, weight: 8 },
      { re: /ご縁がなかった/, weight: 7 },
      { re: /期待に添えず/, weight: 6 },
      { re: /お力になれず/, weight: 5 },
      { re: /選考結果.{0,20}見送らせていただくことになりました/, weight: 9 },
      { re: /誠に不本意ではございますが/, weight: 6 },
      { re: /入社をお断り/, weight: 8 },
      { re: /厳正なる選考の結果.{0,20}残念ながら/, weight: 8 },
      { re: /今回の採用を見送らせて/, weight: 8 },
      { re: /総合的に判断.{0,15}(見送|辞退)/, weight: 6 }
    ]
  },
  {
    category: "面接日程調整",
    patterns: [
      { re: /面接.{0,10}(日程|候補日|ご都合)/, weight: 9 },
      { re: /(日程|候補日).{0,10}面接/, weight: 9 },
      { re: /面接希望日/, weight: 8 },
      { re: /面接.{0,15}調整/, weight: 7 },
      { re: /面談.{0,10}(日程|候補日)/, weight: 7 },
      { re: /ご都合.{0,10}(よろしい日|教えてください)/, weight: 5 },
      { re: /面接日程調整のお願い/, weight: 9 },
      { re: /以下の候補日/, weight: 6 },
      { re: /ご都合の良い日程/, weight: 6 },
      { re: /面接日時のご相談/, weight: 7 },
      { re: /複数.{0,5}日程.{0,10}(選択|お選び)/, weight: 6 },
      { re: /返信フォームより.{0,10}(選択|回答)/, weight: 5 },
      { re: /日程調整.{0,10}(フォーム|URL)/, weight: 6 }
    ]
  },
  {
    category: "面接案内",
    patterns: [
      { re: /面接/, weight: 3 },
      { re: /最終面接/, weight: 6 },
      { re: /一次面接|二次面接|三次面接/, weight: 6 },
      { re: /WEB面接|Web面接|オンライン面接/, weight: 6 },
      { re: /面接.{0,10}(実施|お願い|のご案内)/, weight: 6 },
      { re: /グループ面接|個人面接|集団面接/, weight: 6 },
      { re: /面接会場/, weight: 6 },
      { re: /下記日程にて面接/, weight: 7 },
      { re: /面接を実施させていただきます/, weight: 7 },
      { re: /人事面接|役員面接|社長面接/, weight: 7 }
    ]
  },
  {
    category: "説明会案内",
    patterns: [
      { re: /会社説明会/, weight: 8 },
      { re: /説明会/, weight: 6 },
      { re: /会社紹介セミナー/, weight: 6 },
      { re: /企業説明会/, weight: 7 },
      { re: /オンライン説明会/, weight: 7 },
      { re: /合同説明会/, weight: 6 },
      { re: /就職セミナー|業界研究セミナー/, weight: 6 },
      { re: /WEBセミナー|ウェブセミナー/i, weight: 5 },
      { re: /事業内容.{0,10}説明/, weight: 4 }
    ]
  },
  {
    category: "インターン案内",
    patterns: [
      { re: /インターンシップ/, weight: 8 },
      { re: /インターン/, weight: 6 },
      { re: /就業体験/, weight: 6 },
      { re: /インターンシップ選考/, weight: 7 },
      { re: /サマーインターン|ウィンターインターン|冬季インターン|夏季インターン/, weight: 7 },
      { re: /1day仕事体験|1dayインターン|ワンデー仕事体験/i, weight: 7 },
      { re: /オープンカンパニー/, weight: 6 },
      { re: /就業体験プログラム/, weight: 6 }
    ]
  },
  {
    category: "座談会案内",
    patterns: [
      { re: /座談会/, weight: 7 },
      { re: /社員交流会|先輩社員.{0,10}座談会/, weight: 6 },
      { re: /若手社員座談会/, weight: 7 },
      { re: /OB訪問|OG訪問/, weight: 6 },
      { re: /社員との懇談会|懇親会/, weight: 5 },
      { re: /交流イベント/, weight: 5 }
    ]
  },
  {
    category: "適性検査・WEBテスト",
    patterns: [
      { re: /WEBテスト|Webテスト/i, weight: 8 },
      { re: /適性検査/, weight: 8 },
      { re: /SPI/, weight: 7 },
      { re: /玉手箱/, weight: 7 },
      { re: /Webテスティング|テストセンター/i, weight: 7 },
      { re: /TG-WEB/i, weight: 7 },
      { re: /CAB|GAB/, weight: 6 },
      { re: /性格検査|能力検査/, weight: 6 },
      { re: /言語.{0,3}非言語/, weight: 6 },
      { re: /受検.{0,5}期限/, weight: 6 },
      { re: /Webテストの受験/i, weight: 7 }
    ]
  },
  {
    category: "課題提出",
    patterns: [
      { re: /課題.{0,10}(提出|ご提出)/, weight: 8 },
      { re: /レポート提出|ワーク提出/, weight: 7 },
      { re: /事前課題/, weight: 7 },
      { re: /志望動機シート/, weight: 6 },
      { re: /アンケート.{0,10}(ご回答|ご記入)/, weight: 5 },
      { re: /エントリーシート.{0,10}(提出|ご提出)/, weight: 7 },
      { re: /ES.{0,5}提出/, weight: 6 }
    ]
  },
  {
    category: "選考優遇案内",
    patterns: [
      { re: /優遇/, weight: 6 },
      { re: /選考.{0,10}優遇/, weight: 8 },
      { re: /早期選考のご案内/, weight: 8 },
      { re: /特別選考ルート/, weight: 8 },
      { re: /一部選考.{0,5}免除/, weight: 7 },
      { re: /優遇ルートへご案内/, weight: 8 },
      { re: /特別ルート/, weight: 6 }
    ]
  },
  {
    category: "締切案内",
    patterns: [
      { re: /締切|締め切り|〆切/, weight: 5 },
      { re: /(提出|応募|回答).{0,5}期限/, weight: 6 },
      { re: /本日締切|締切間近|締切迫/, weight: 7 },
      { re: /期限が迫って/, weight: 6 },
      { re: /応募締切/, weight: 6 },
      { re: /提出期限/, weight: 6 },
      { re: /受付終了/, weight: 5 }
    ]
  },
  {
    category: "エントリー案内",
    patterns: [
      { re: /エントリー/, weight: 5 },
      { re: /応募受付/, weight: 5 },
      { re: /プレエントリー/, weight: 6 },
      { re: /新規エントリー/, weight: 6 },
      { re: /エントリー受付開始/, weight: 7 },
      { re: /エントリー受付中/, weight: 8 },
      { re: /マイページ.{0,10}登録/, weight: 5 },
      { re: /本選考エントリー/, weight: 7 },
      { re: /求人情報を公開/, weight: 5 },
      { re: /エントリーをお願い/, weight: 8 },
      { re: /選考.{0,5}エントリー/, weight: 7 },
      { re: /エントリーいただけます/, weight: 6 },
      { re: /エントリーをお待ちして/, weight: 6 }
    ]
  },
  {
    category: "書類選考通過",
    patterns: [
      { re: /書類選考.{0,10}通過/, weight: 9 },
      { re: /選考.{0,10}通過/, weight: 7 },
      { re: /次の選考.{0,10}(案内|ご案内)/, weight: 6 },
      { re: /(?<!不)通過/, weight: 4 },
      { re: /一次選考通過のお知らせ/, weight: 8 },
      { re: /次選考へお進み/, weight: 7 }
    ]
  },
  {
    category: "合格・内定",
    patterns: [
      // 「内定」単体ではなく「内定通知」「内定のご連絡」など採用の文脈に限定
      { re: /内定.{0,10}(通知|のご連絡|おめでとう|承諾|辞退|式)/, weight: 10 },
      { re: /内定をお伝え|内定させていただ|内定となりました/, weight: 10 },
      { re: /採用通知|採用が決定|採用内定/, weight: 9 },
      // 「合格」は「選考合格」「最終合格」など選考文脈に限定
      { re: /選考.{0,10}合格|最終.{0,10}合格|面接.{0,10}合格/, weight: 9 },
      { re: /合格.{0,10}(おめでとう|のご連絡|通知)/, weight: 8 },
      { re: /内々定/, weight: 9 },
      { re: /内定式のご案内/, weight: 9 },
      { re: /入社承諾書/, weight: 7 },
      // ← 「内定」単体・「合格」単体は除外（他カテゴリへの誤判定の原因）
      // 「内定獲得のコツ／探し方」のようなノウハウ記事は実際の内定通知ではないので打ち消す
      { re: /内々?定獲得(のコツ|に向けた)/, weight: -20 },
      { re: /内々?定.{0,10}(のもらい方|の取り方)/, weight: -20 }
    ]
  },
  {
    category: "イベント案内",
    patterns: [
      { re: /就活イベント|採用イベント/, weight: 6 },
      { re: /イベント/, weight: 3 },
      { re: /本イベント/, weight: 10 },
      { re: /イベントに参加/, weight: 15 },
      { re: /キャリアイベント/, weight: 6 },
      { re: /就活サポートイベント/, weight: 6 },
      { re: /相談会/, weight: 5 }
    ]
  },
  {
    category: "要返信",
    patterns: [
      { re: /ご返信|お返事/, weight: 4 },
      { re: /ご回答をお願い/, weight: 4 },
      { re: /お早めにご返信/, weight: 5 },
      { re: /出欠.{0,10}ご返信/, weight: 6 },
      { re: /参加可否.{0,10}(ご返信|ご回答)/, weight: 6 },
      { re: /アンケートにご回答ください/, weight: 5 }
    ]
  }
];

// 一斉配信メルマガによくある定型フッター（これが出たら「個人宛の重要な通知」らしさを一律で下げる）
const NEWSLETTER_FOOTER_PATTERNS = [
  /■配信の停止/,
  /■登録内容の変更/,
  /■よくある質問/,
  /マイナビ編集部/,
  /このメールの再配信および掲載記事の無断転載は禁止/,
  /配信停止をご希望の方/
];

function detectCategory(text, subjectText = "") {
  if (!isJobRelated(text)) return { category: "その他", score: 0 };

  const isNewsletter = NEWSLETTER_FOOTER_PATTERNS.some(re => re.test(text));
  const newsletterPenalty = isNewsletter ? 6 : 0;

  let bestCategory = "その他";
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    rule.patterns.forEach(p => {
      if (p.re.test(text)) {
        score += p.weight;
        // 件名にも同じキーワードが出てくる場合はボーナス加点する
        // （本文の奥にある一言よりも、件名の主旨のほうがそのメールの本来のカテゴリを反映しやすいため）
        if (subjectText && p.re.test(subjectText)) score += p.weight;
      }
    });
    score -= newsletterPenalty;
    if (score > bestScore) { bestScore = score; bestCategory = rule.category; }
  }

  if (bestScore < 5) return { category: "その他", score: bestScore };
  return { category: bestCategory, score: bestScore };
}

// ===============================
// 開催形式の検出
// ===============================
function detectFormat(text) {
  const online = /(Zoom|Teams|Google\s?Meet|Webex|Skype|オンライン|Web面接|ウェブ面接|オンライン開催|オンライン形式|WEB開催)/i.test(text);
  const offline = /(対面|来社|本社にて|弊社オフィス|会場にて|現地開催|会場開催|対面形式)/.test(text);
  if (online && offline) return "対面/オンライン選択可";
  if (online) return "オンライン";
  if (offline) return "対面";
  return "";
}

// ===============================
// 企業名の抽出
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

  const looksInvalid = !name ||
    /^(no-?reply|info|mailer|support|notification|system)/i.test(name) ||
    /@/.test(name);

  if (looksInvalid && body) {
    const sigMatch = body.match(
      /(株式会社[^\s\n　、。]{1,20}|[^\s\n　、。]{1,20}株式会社|合同会社[^\s\n　、。]{1,20}|[^\s\n　、。]{1,20}合同会社)/
    );
    if (sigMatch) return sigMatch[1];
  }

  if (looksInvalid && fromHeader) {
    const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
    const domainMatch = (emailMatch[1] || "").match(/@([^.]+)\./);
    if (domainMatch && !/^(gmail|yahoo|outlook|hotmail|icloud|mail|google)$/i.test(domainMatch[1])) {
      return `${domainMatch[1]}（ドメインから推測）`;
    }
  }
  return name;
}

// ===============================
// 日時抽出：本文中の全候補を列挙する
// ===============================
// 日付の前後から時刻を探す（午前/午後の指定も考慮する）
function findNearbyTime(text, index) {
  const windowStart = Math.max(0, index - 15);
  const before = text.slice(windowStart, index);
  const after  = text.slice(index, index + 80);

  const timeRe = /(\d{1,2}):(\d{2})|(\d{1,2})時(?:(\d{1,2})分)?/;
  const tm = after.match(timeRe) || before.match(timeRe);
  if (!tm) return { hasTime: false, hour: 9, minute: 0 };

  let hour   = tm[1] !== undefined ? Number(tm[1]) : Number(tm[3]);
  let minute = tm[2] !== undefined ? Number(tm[2]) : (tm[4] ? Number(tm[4]) : 0);

  // 「午前/午後」は時刻の直前に書かれることが多いので、時刻の少し手前も含めて探す
  const ampmScanStart = Math.max(0, windowStart);
  const ampmZone = text.slice(ampmScanStart, index + 20);
  const ampmMatch = ampmZone.match(/(午前|午後)/);
  if (ampmMatch) {
    if (ampmMatch[1] === "午後" && hour < 12) hour += 12;
    if (ampmMatch[1] === "午前" && hour === 12) hour = 0;
  }

  if (hour > 23 || minute > 59) return { hasTime: false, hour: 9, minute: 0 };
  return { hasTime: true, hour, minute };
}

function extractAllDateTimes(text, baseDate) {
  const results = [];

  // 絶対日付（○月○日・○/○・○年○月○日）
  // 「６月　８日」のように月と日の間に体裁調整の空白が入ることがあるため、\s*で許容する
  const dateRegex = /(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(\d{1,2})\/(\d{1,2})(?!\d)/g;
  let m;
  while ((m = dateRegex.exec(text)) !== null) {
    const month = m[2] ? Number(m[2]) : Number(m[4]);
    const day   = m[2] ? Number(m[3]) : Number(m[5]);
    const year  = m[1] ? Number(m[1]) : null;
    if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) continue;

    const { hasTime, hour, minute } = findNearbyTime(text, m.index);

    let useYear = year || baseDate.getFullYear();
    let d = new Date(useYear, month - 1, day, hour, minute);
    if (!year && (d - baseDate) / 86400000 < -60) {
      d = new Date(useYear + 1, month - 1, day, hour, minute);
    }
    results.push({ date: d, hasTime, index: m.index });
  }

  // 相対日付（本日・明日・明後日・今週・来週月曜など）
  const relativeRegex = /(本日|今日|明日|明後日|今週|来週)(?:の)?(月|火|水|木|金|土|日)?曜?日?/g;
  const weekdayIndex = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6 };
  let rm;
  while ((rm = relativeRegex.exec(text)) !== null) {
    let target = new Date(baseDate);
    target.setHours(0, 0, 0, 0);
    if (rm[1] === "本日" || rm[1] === "今日") {
      // targetはすでに今日の0時なのでそのまま
    } else if (rm[1] === "明日") {
      target.setDate(target.getDate() + 1);
    } else if (rm[1] === "明後日") {
      target.setDate(target.getDate() + 2);
    } else if ((rm[1] === "今週" || rm[1] === "来週") && rm[2]) {
      const wd = weekdayIndex[rm[2]];
      const base = rm[1] === "来週"
        ? new Date(target.getFullYear(), target.getMonth(), target.getDate() + 7)
        : target;
      const diff = (wd - base.getDay() + 7) % 7;
      target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + diff);
    } else continue;

    const { hasTime, hour, minute } = findNearbyTime(text, rm.index + rm[0].length);
    target.setHours(hour, minute, 0, 0);
    results.push({ date: target, hasTime, index: rm.index });
  }

  // 重複除去
  const seen = new Set();
  return results.filter(r => {
    const key = r.date.getTime();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 締切ワード周辺の日付を締切日として返す
function pickDeadlineDate(candidates, text) {
  const deadlineRegex = /(締切|締め切り|〆切|必着|消印有効|期限|まで.{0,5}(ご返信|ご回答|お申し込み|提出|に(ご)?エントリー)|エントリー.{0,10}まで)/g;
  const deadlinePositions = [];
  let m;
  while ((m = deadlineRegex.exec(text)) !== null) deadlinePositions.push(m.index);
  if (!deadlinePositions.length) return null;

  // 締切キーワードの近くにある候補を、距離が近い順に集める
  const nearby = [];
  candidates.forEach(c => {
    deadlinePositions.forEach(pos => {
      const dist = Math.abs(c.index - pos);
      if (dist < 80) nearby.push({ candidate: c, dist });
    });
  });
  if (!nearby.length) return null;

  // 同じくらい近い候補が複数ある場合、時刻情報がある方（＝より具体的な締切表記）を優先する
  const withTime = nearby.filter(n => n.candidate.hasTime);
  const pool = withTime.length > 0 ? withTime : nearby;

  pool.sort((a, b) => a.dist - b.dist);
  return pool[0].candidate;
}

// イベント日時（締切以外で一番近い未来の日時）
function pickEventDate(candidates, text, baseDate) {
  if (!candidates.length) return null;
  const deadlineWords = /(締切|締め切り|〆切)/;
  const nonDeadline = candidates.filter(c => {
    const around = text.slice(Math.max(0, c.index - 20), c.index + 20);
    return !deadlineWords.test(around);
  });
  const pool = nonDeadline.length > 0 ? nonDeadline : candidates;
  const withTime = pool.filter(c => c.hasTime);
  const targetPool = withTime.length > 0 ? withTime : pool;
  const future = targetPool.filter(c => c.date >= baseDate);
  const chosen = (future.length > 0 ? future : targetPool).sort((a, b) => a.date - b.date)[0];
  return chosen || null;
}

// ===============================
// カレンダーカテゴリ変換
// ===============================
function mapToCalendarCategory(category) {
  const map = {
    "面接案内": "面接", "面接日程調整": "面接",
    "説明会案内": "説明会", "インターン案内": "インターン",
    "座談会案内": "説明会", "イベント案内": "説明会",
    "締切案内": "締切", "エントリー案内": "締切",
    "適性検査・WEBテスト": "締切", "課題提出": "締切"
  };
  return map[category] || null;
}
function shortenCategory(c) { return c.replace(/案内|・WEBテスト/g, ""); }

// ===============================
// 本文抽出
// ===============================
function stripHtml(html) {
  let text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"");

  // 空白だけの行を空行として扱う（改行の間に半角スペースが挟まってると
  // 通常の「連続改行つぶし」が効かないため、先に行単位で空白を除去する）
  text = text
    .split("\n")
    .map(line => line.trim())
    .join("\n");

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(payload) {
  if (!payload.parts) {
    if (!payload.body?.data) return "";
    const decoded = decodeBase64(payload.body.data);
    // multipartではない単一メールでも、中身がHTMLならタグを除去する
    return payload.mimeType === "text/html" ? stripHtml(decoded) : decoded;
  }
  const findPart = (parts, mime) => {
    for (const p of parts) {
      if (p.mimeType === mime && p.body?.data) return p.body.data;
      if (p.parts) { const n = findPart(p.parts, mime); if (n) return n; }
    }
    return null;
  };

  const plainData = findPart(payload.parts, "text/plain");
  const htmlData   = findPart(payload.parts, "text/html");

  const plainText = plainData ? decodeBase64(plainData).trim() : "";
  const htmlText  = htmlData  ? stripHtml(decodeBase64(htmlData)).trim() : "";

  // text/plainが「プレビュー用の一言」だけで内容が薄いメールもあるため、
  // 単純にtext/plainを優先するのではなく、内容がより多い方を採用する
  if (plainText && htmlText) {
    return plainText.length >= htmlText.length ? plainText : htmlText;
  }
  return plainText || htmlText || "";
}

function decodeBase64(str) {
  try { return decodeURIComponent(escape(atob(str.replace(/-/g, "+").replace(/_/g, "/")))); }
  catch (e) { return ""; }
}

// ===============================
// Gmail API でメール同期
// ===============================
// ===============================
// メールID一覧の取得
// ===============================

// 初回同期：ページネーションしながら全件取得（安全のため上限あり）
async function fetchAllMessageIds(token, cap = 500) {
  let messages = [];
  let pageToken = null;

  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.messages) messages = messages.concat(data.messages);
    pageToken = data.nextPageToken;
  } while (pageToken && messages.length < cap);

  return messages.slice(0, cap);
}

// 2回目以降の同期：前回より新しいメールだけを取得（差分同期）
async function fetchMessageIdsSince(token, sinceIso, cap = 1000) {
  // 境界ちょうどで漏れないよう60秒分バッファを持たせる
  const sinceEpoch = Math.floor(new Date(sinceIso).getTime() / 1000) - 60;

  let messages = [];
  let pageToken = null;

  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", `after:${sinceEpoch}`);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.messages) messages = messages.concat(data.messages);
    pageToken = data.nextPageToken;
  } while (pageToken && messages.length < cap);

  return messages.slice(0, cap);
}

// ===============================
// 同期状況の見える化
// Gmail側の総メール数と、ローカルに保存できてる件数を突き合わせて、
// 同期がちゃんと進んでるか目視確認できるようにする
// ===============================
export async function getSyncHealthCheck() {
  const token = localStorage.getItem("gmailToken");
  if (!token) { alert("Googleログインしてください"); return null; }

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const profile = await res.json();

  if (!res.ok || profile.error) {
    console.error("プロフィール取得エラー:", profile.error || res.status);
    return { error: true };
  }

  const saved = JSON.parse(localStorage.getItem("savedMails") || "[]");
  const lastSyncedMaxDate = localStorage.getItem("lastSyncedMaxDate");

  return {
    error: false,
    gmailTotal: profile.messagesTotal,
    localTotal: saved.length,
    lastSyncedMaxDate,
    isFirstSyncDone: !!lastSyncedMaxDate
  };
}

export async function syncMails(options = {}) {
  const { silent = false } = options;
  const token = localStorage.getItem("gmailToken");
  if (!token) { if (!silent) alert("Googleログインしてください"); return; }

  const lastSyncedMaxDate = localStorage.getItem("lastSyncedMaxDate");
  const isFirstSync = !lastSyncedMaxDate;

  const messageRefs = isFirstSync
    ? await fetchAllMessageIds(token)
    : await fetchMessageIdsSince(token, lastSyncedMaxDate);

  const existingMails = JSON.parse(localStorage.getItem("savedMails") || "[]");
  const existingMap = new Map(existingMails.map(m => [m.id, m]));

  if (messageRefs.length === 0) {
    localStorage.setItem("lastSyncedAt", new Date().toISOString());
    if (document.getElementById("todayMailList")) loadTodayMails();
    if (!silent) alert("新しいメールはありませんでした");
    return;
  }

  // 既読判定は「このブラウザが最後に見た状態」より「Supabase上の最新状態」を優先する
  const readMap = await refreshReadStatus() || new Map();

  // メール詳細の取得・解析を1件ずつ待たず、同時に複数件処理する（同時実行数は6件まで）
  const fetchedMails = await mapWithConcurrency(messageRefs, 6, async (msg) => {
    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const detailData = await detailRes.json();
    const headers = detailData.payload.headers;
    const subject    = headers.find(h => h.name === "Subject")?.value || "";
    const fromHeader = headers.find(h => h.name === "From")?.value || "";
    const body = extractBody(detailData.payload);
    const receivedDate = new Date(Number(detailData.internalDate));
    const date = receivedDate.toISOString();
    const fullText = normalizeText(subject + "\n" + body);

    const company  = extractCompany(fromHeader, body);
    const { category } = detectCategory(fullText, normalizeText(subject));
    const format   = detectFormat(fullText);
    const allDates = extractAllDateTimes(fullText, receivedDate);
    const eventInfo    = pickEventDate(allDates, fullText, receivedDate);
    const deadlineInfo = pickDeadlineDate(allDates, fullText);
    const existing = existingMap.get(msg.id);
    const read = readMap.has(msg.id) ? readMap.get(msg.id) : (existing ? !!existing.read : false);

    const mailObj = {
      id: msg.id,
      subject, from: fromHeader, company, body, category, format, date,
      eventDate:    eventInfo    ? eventInfo.date.toISOString()    : null,
      deadlineDate: deadlineInfo ? deadlineInfo.date.toISOString() : null,
      candidateDates: allDates.map(d => d.date.toISOString()),
      read
    };

    await saveMail(mailObj);

    const calendarCategory = mapToCalendarCategory(category);
    if (eventInfo && calendarCategory) {
      const title = `${company || "(企業名不明)"} ${shortenCategory(category)}${format ? `（${format}）` : ""}`;
      addEventAuto(title, eventInfo.date, calendarCategory, msg.id);
    }
    if (deadlineInfo && (!eventInfo || Math.abs(deadlineInfo.date - eventInfo.date) > 86400000)) {
      const deadlineTitle = `${company || "(企業名不明)"} 締切（${shortenCategory(category)}）`;
      addEventAuto(deadlineTitle, deadlineInfo.date, "締切", `${msg.id}-deadline`);
    }

    return mailObj;
  });

  // 差分取得の場合は既存データと突き合わせてマージ（同じIDは新しい方で上書き）
  const fetchedIds = new Set(fetchedMails.map(m => m.id));
  const merged = [...fetchedMails, ...existingMails.filter(m => !fetchedIds.has(m.id))];

  localStorage.setItem("savedMails", JSON.stringify(merged));

  // 次回の差分同期の基準日時（今回取得した中で一番新しい受信日時）を更新
  const newestFetchedDate = fetchedMails.reduce(
    (max, m) => (!max || m.date > max) ? m.date : max,
    lastSyncedMaxDate
  );
  if (newestFetchedDate) localStorage.setItem("lastSyncedMaxDate", newestFetchedDate);

  localStorage.setItem("lastSyncedAt", new Date().toISOString());
  if (document.getElementById("todayMailList")) loadTodayMails();
  if (document.getElementById("folderGrid")) window.dispatchEvent(new Event("mailsSynced"));
  if (!silent) alert(isFirstSync ? "全メール取得完了！" : `メール同期完了！（新着${fetchedMails.length}件）`);
}

// ===============================
// Supabase 保存
// ===============================
export async function saveMail(mail) {
  const { error } = await supabase.from("mails").upsert(
    [{
      gmail_id: mail.id, subject: mail.subject, from_address: mail.from,
      company: mail.company, body: mail.body, category: mail.category,
      format: mail.format, date: mail.date,
      event_date: mail.eventDate, deadline_date: mail.deadlineDate,
      read: mail.read
    }],
    { onConflict: "gmail_id" }
  );
  if (error) console.error(error);
}

// ===============================
// 既読状態をSupabaseから取り込む（端末間の食い違い対策）
// localStorageは端末ごとに別物なので、表示前にSupabase側の
// 最新のread状態をローカルキャッシュへ反映してから描画する
// ===============================
export async function refreshReadStatus() {
  const { data, error } = await supabase.from("mails").select("gmail_id, read");
  if (error) { console.error(error); return; }

  const readMap = new Map(data.map(row => [row.gmail_id, !!row.read]));
  const mails = JSON.parse(localStorage.getItem("savedMails") || "[]");
  let changed = false;

  mails.forEach(mail => {
    if (readMap.has(mail.id)) {
      const latestRead = readMap.get(mail.id);
      if (mail.read !== latestRead) {
        mail.read = latestRead;
        changed = true;
      }
    }
  });

  if (changed) localStorage.setItem("savedMails", JSON.stringify(mails));
  return readMap;
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
  const { error } = await supabase.from("mails").update({ read: true }).eq("gmail_id", id);
  if (error) console.error(error);
  return target;
}

export function getMailById(id) {
  const mails = JSON.parse(localStorage.getItem("savedMails") || "[]");
  return mails.find(m => m.id === id) || null;
}

// ===============================
// 今日のメール表示
// ===============================
function goToMail(id) { location.href = `mail.html?id=${encodeURIComponent(id)}`; }

export function loadTodayMails() {
  const saved = localStorage.getItem("savedMails");
  const list  = document.getElementById("todayMailList");
  if (!list) return;
  list.innerHTML = "";

  if (!saved) { list.innerHTML = `<p style="color:#888;">まだ同期していません</p>`; return; }

  const today = new Date().toISOString().slice(0, 10);
  const todayMails = JSON.parse(saved).filter(m => m.date?.startsWith(today));

  if (!todayMails.length) { list.innerHTML = `<p style="color:#888;">今日届いたメールはありません</p>`; return; }

  todayMails.forEach(mail => {
    const unreadMark = mail.read ? "" : `<span style="color:var(--seal);">●</span> `;
    const div = document.createElement("div");
    div.className = "mail-item";
    div.style.fontWeight = mail.read ? "normal" : "bold";
    div.innerHTML = `
      ${unreadMark}<strong>${escapeHtml(mail.subject)}</strong><br>
      <span style="color:var(--ink-soft);">${escapeHtml(mail.company || mail.from)} ・ ${formatMailDate(mail.date)}</span>
    `;
    div.onclick = () => goToMail(mail.id);
    list.appendChild(div);
  });
}

// ===============================
// フォルダー別表示
// ===============================
export function loadFolderMails(category) {
  const saved = localStorage.getItem("savedMails");
  if (!saved) return;
  const list = document.getElementById("folderList");
  list.innerHTML = "";
  JSON.parse(saved).filter(m => m.category === category).forEach(mail => {
    const unreadMark = mail.read ? "" : `<span style="color:var(--seal);">●</span> `;
    const tr = document.createElement("tr");
    tr.style.fontWeight = mail.read ? "normal" : "bold";
    tr.innerHTML = `
      <td>${escapeHtml(mail.company || mail.from)}</td>
      <td>${unreadMark}${escapeHtml(mail.subject)}</td>
      <td>${escapeHtml(mail.category)}</td>
      <td>${formatMailDate(mail.date)}</td>
    `;
    tr.onclick = () => goToMail(mail.id);
    list.appendChild(tr);
  });
}

// ===============================
// フォルダー件数（未読含む）
// ===============================
export function getFolderCounts() {
  const saved = localStorage.getItem("savedMails");
  if (!saved) return {};
  const counts = {};
  JSON.parse(saved).forEach(mail => {
    if (!counts[mail.category]) counts[mail.category] = { total: 0, unread: 0 };
    counts[mail.category].total++;
    if (!mail.read) counts[mail.category].unread++;
  });
  return counts;
}

// ===============================
// 最終同期日時
// ===============================
export function getLastSyncedAt()   { return localStorage.getItem("lastSyncedAt"); }

// ===============================
// グローバル公開
// ===============================
window.loginWithGoogle  = loginWithGoogle;
window.syncMails        = syncMails;
window.getSyncHealthCheck = getSyncHealthCheck;
window.loadTodayMails   = loadTodayMails;
window.loadFolderMails  = loadFolderMails;
window.getFolderCounts  = getFolderCounts;