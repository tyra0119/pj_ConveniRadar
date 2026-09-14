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

export async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.name === 'AbortError' ? '通信がタイムアウトしました' : e.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末では現在地を取得できません'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(`現在地を取得できませんでした（${e.message}）`)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

// Googleマップの徒歩ナビ。徒歩は経由地を指定できないので 1 区間ずつ開く
export const walkNavUrl = (p) => `https://www.google.com/maps/dir/?api=1&travelmode=walking&dir_action=navigate&destination=${p.lat},${p.lng}`;
