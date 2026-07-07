// ===============================
// ログイン状態の管理（全ページ共通）
// ===============================
const TOKEN_KEY = "gmailToken";

export function isLoggedIn() {
  return !!localStorage.getItem(TOKEN_KEY);
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  alert("ログアウトしました");
  updateLoginUI();
}

// ログイン状態に応じてボタンの表示・非表示を切り替える
export function updateLoginUI() {
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (loginBtn) loginBtn.style.display = isLoggedIn() ? "none" : "inline-block";
  if (logoutBtn) logoutBtn.style.display = isLoggedIn() ? "inline-block" : "none";
}

// HTML側のonclickから呼べるようにグローバル公開
window.logout = logout;
