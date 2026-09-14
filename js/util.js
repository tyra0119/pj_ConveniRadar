// 画面・通信・距離の小道具（lawson/app.js から移したもの）

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const fmtDist = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);

export function fmtDur(sec) {
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60}分`;
}

// 時刻は「その日の 0:00 からの分」で持つ。24 時を過ぎた終電も 24:10 のように続けて数える
export function fmtMin(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;
}

export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let toastTimer;
export function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// 見つからない・失敗したときの知らせ。画面下の小さい表示（toast）では分かりにくいと指摘された（2026-09-14）ので、
// 検索中と同じく画面を暗くして中央に出し、OK を押すまで残す。成功の知らせは toast のまま
export function notice(message, { title = 'お知らせ', icon = '⚠' } = {}) {
  const box = $('#notice');
  if (!box) return toast(message, 8000);
  $('#notice-icon').textContent = icon;
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = message;
  box.hidden = false;
  $('#notice-ok').focus();
}

export function closeNotice() {
  const box = $('#notice');
  if (box) box.hidden = true;
}

// 確かめてから進める操作（中央のカード）。OK なら true、キャンセル・暗い所・Esc なら false
export function ask(message, { title = '確認', icon = '⚠', okLabel = 'OK', cancelLabel = 'キャンセル', danger = false } = {}) {
  const box = $('#ask');
  if (!box) return Promise.resolve(window.confirm(message));
  $('#ask-icon').textContent = icon;
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = message;
  const ok = $('#ask-ok');
  const cancel = $('#ask-cancel');
  ok.textContent = okLabel;
  cancel.textContent = cancelLabel;
  ok.classList.toggle('danger', danger);
  ok.classList.toggle('primary', !danger);
  box.hidden = false;
  cancel.focus();
  return new Promise((resolve) => {
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };
    function done(value) {
      box.hidden = true;
      ok.onclick = null;
      cancel.onclick = null;
      box.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    box.onclick = (e) => {
      if (e.target === box) done(false);
    };
    document.addEventListener('keydown', onKey);
  });
}

// 利用者が止めた（「中断」を押した）ときのエラー。失敗ではないので、中央の知らせではなく小さく知らせる
export class CancelError extends Error {
  constructor(message = '中断しました') {
    super(message);
    this.name = 'CancelError';
  }
}

// options.signal を渡すと、呼び出し側からも止められる（時間切れとは別に）
export async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = options.signal;
  const stop = () => ctrl.abort();
  if (outer?.aborted) stop();
  outer?.addEventListener('abort', stop);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  }
}

export async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    if (e.name === 'CancelError') {
      toast(e.message, 5000);
      return undefined;
    }
    console.error(e);
    notice(e.name === 'AbortError' ? '通信がタイムアウトしました。電波の良い所で、もう一度試してください' : e.message, { title: 'うまくいきませんでした' });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 現在地。まず GPS（高精度）で取り、取れなければ（屋内・PC など）精度を落として取り直す。
// 失敗の理由をブラウザの英語のまま出していて、押しても何も起きないように見えた（2026-09-14）ので、理由ごとに日本語で案内する
export function getPosition() {
  if (!navigator.geolocation) return Promise.reject(new Error('この端末・ブラウザでは現在地を取得できません。「タップした場所を中心に」を使ってください'));
  if (!window.isSecureContext) return Promise.reject(new Error('現在地は https のページでだけ使えます'));
  const once = (options) => new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      options,
    );
  });
  return once({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
    .catch((e) => (e.code === 1 ? Promise.reject(e) : once({ enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 })))
    .catch((e) => {
      const why = e.code === 1
        ? '位置情報の利用が許可されていません。ブラウザ（スマホは設定アプリ）で、このサイトの位置情報を「許可」にしてください。または「タップした場所を中心に」を使ってください'
        : e.code === 3
          ? '現在地の取得に時間がかかりすぎました。屋外で試すか、「タップした場所を中心に」を使ってください'
          : '現在地を特定できませんでした。位置情報サービスがオンか確かめるか、「タップした場所を中心に」を使ってください';
      throw new Error(why);
    });
}

// Googleマップの徒歩ナビ。徒歩は経由地を指定できないので 1 区間ずつ開く
export const walkNavUrl = (p) => `https://www.google.com/maps/dir/?api=1&travelmode=walking&dir_action=navigate&destination=${p.lat},${p.lng}`;
