// コンビニの検索（OpenStreetMap / Overpass）。チェーン判定と重複除去は lawson/app.js から移したもの
import { fetchJson, haversine } from './util.js?v=933c2d17';

// icon はチェーンの配色をもとにした簡易アイコン（公式ロゴではない）
export const CHAINS = {
  lawson: {
    label: 'ローソン',
    color: '#0068b7',
    re: /ローソン|lawson/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#0068b7" stroke="#fff" stroke-width="2"/><path d="M12.5 6h7v3.2l3 3.3V24a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V12.5l3-3.3z" fill="#fff"/><rect x="9.5" y="15.5" width="13" height="5" fill="#0068b7"/></svg>',
  },
  seven: {
    label: 'セブン-イレブン',
    color: '#e8590c',
    re: /セブン[\s\-‐－ー・]?イレブン|7[\s\-‐]?eleven|seven[\s\-‐]?eleven/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#fff" stroke-width="2"/><rect x="4" y="7" width="24" height="5.5" fill="#f58220"/><rect x="4" y="13.25" width="24" height="5.5" fill="#00a650"/><rect x="4" y="19.5" width="24" height="5.5" fill="#ee2e24"/><text x="16" y="24.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="900" fill="#fff" stroke="#1d2330" stroke-width="1.4" paint-order="stroke">7</text></svg>',
  },
  family: {
    label: 'ファミリーマート',
    color: '#2b8a3e',
    // サークルK・サンクスは国内全店がファミリーマートに転換済みだが、OSM に旧名のまま残っていることがある
    re: /ファミリーマート|family\s?mart|サンクス|sunkus|サークル\s?K|circle\s?k/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#fff" stroke-width="2"/><path d="M1 8a7 7 0 0 1 7-7h16a7 7 0 0 1 7 7v3H1z" fill="#0a8ad2"/><path d="M1 21h30v3a7 7 0 0 1-7 7H8a7 7 0 0 1-7-7z" fill="#00a73c"/><text x="16" y="20.3" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" fill="#0a8ad2">F</text></svg>',
  },
  ministop: {
    label: 'ミニストップ',
    color: '#1c3f94',
    re: /ミニストップ|mini\s?stop/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#1c3f94" stroke="#fff" stroke-width="2"/><text x="16" y="21" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="900" fill="#fff">M</text><rect x="7" y="23.5" width="18" height="3" rx="1.5" fill="#ffd200"/></svg>',
  },
  // 駅ナカ・駅前に多いので電車版では最初から入れる
  newdays: {
    label: 'NewDays',
    color: '#1a7f37',
    re: /newdays|ニューデイズ/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#fff" stroke-width="2"/><rect x="3" y="3" width="26" height="26" rx="5" fill="#1a7f37"/><text x="16" y="21" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="900" fill="#fff">N</text></svg>',
  },
};

export const STATUSES = {
  bought: { label: '購入', icon: '🎯', tone: 'ok' },
  soldout: { label: '売切れ', icon: '❌', tone: 'ng' },
  none: { label: '取扱なし', icon: '🚫', tone: 'ng' },
  skip: { label: 'スキップ', icon: '⏭', tone: 'skip' },
};

// 公開 Overpass サーバーは混雑すると 504 やタイムアウトになるため、応答の速い順に試す。
// maps.mail.ru は応答しないまま待たされることがある（2026-09-14 に 15 秒切れが続いた）ので短めに切り上げる
const OVERPASS_ENDPOINTS = [
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', timeout: 10000 },
  { url: 'https://overpass-api.de/api/interpreter', timeout: 15000 },
  { url: 'https://overpass.kumi.systems/api/interpreter', timeout: 30000 },
];

// 複数の駅それぞれの周り radiusM メートルを 1 回の問い合わせでまとめて探す
export async function fetchStoresAround(points, radiusM) {
  const parts = points.map((p) => `nwr["shop"="convenience"](around:${Math.round(radiusM)},${p.lat.toFixed(6)},${p.lng.toFixed(6)});`);
  const query = `[out:json][timeout:25];(${parts.join('')});out center tags;`;
  const errors = [];
  for (const { url, timeout } of OVERPASS_ENDPOINTS) {
    const host = new URL(url).hostname;
    try {
      const json = await fetchJson(url, { method: 'POST', body: new URLSearchParams({ data: query }) }, timeout);
      // 混雑時は HTTP 200 のまま remark にエラーが入り、結果が空や途中までになることがある
      if (/runtime error|timed out|rate_limited|out of memory/i.test(json.remark ?? '')) throw new Error(json.remark);
      return dedupe(json.elements.map(toStore).filter(Boolean));
    } catch (e) {
      console.warn(host, e);
      errors.push(`${host}: ${e.name === 'AbortError' ? 'タイムアウト' : e.name === 'TypeError' ? '接続できません' : e.message}`);
    }
  }
  throw new Error(`店舗データのサーバーが混雑しています。少し待ってから再検索してください。（${errors.join(' / ')}）`);
}

function toStore(el) {
  const t = el.tags || {};
  const text = [t.brand, t['brand:ja'], t['brand:en'], t.name, t['name:ja'], t['name:en'], t.operator].filter(Boolean).join(' ');
  const chain = Object.keys(CHAINS).find((k) => CHAINS[k].re.test(text));
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!chain || lat == null) return null;
  let name = t.name || t['name:ja'] || CHAINS[chain].label;
  if (t.branch && !name.includes(t.branch)) name += ` ${t.branch}`;
  return { id: `osm:${el.type}/${el.id}`, name, chain, lat, lng };
}

// 同じ店舗が点と建物の両方で登録されている場合の重複を除く
function dedupe(stores) {
  const out = [];
  for (const s of stores) {
    if (!out.some((o) => o.chain === s.chain && haversine(o, s) < 40)) out.push(s);
  }
  return out;
}
