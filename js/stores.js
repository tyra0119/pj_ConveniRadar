// コンビニの検索（OpenStreetMap）。チェーン判定と重複除去は lawson/app.js から移したもの
import { DATA_V } from './config.js?v=a153cd0a';
import { CancelError, fetchJson, haversine } from './util.js?v=a153cd0a';

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

const cancelled = () => new CancelError('店舗の検索を中断しました');

// ===== 前もって作った店舗データ（tools/build_stores.py → docs/data/stores/） =====
// 検索のたびに公開 Overpass サーバーへ問い合わせていたが、混雑すると 504・タイムアウトが続き、
// 店舗検索が頻繁に失敗していた（2026-09-15 利用者の指摘）。ODPT の駅・バス停のまわりの店は先に取っておき、ここを読むだけにする
let indexLoading = null;
const tileLoading = new Map();

function loadStoreIndex() {
  indexLoading ??= fetchJson(`data/stores/index.json${DATA_V}`, {}, 20000).catch((e) => {
    indexLoading = null;
    throw e;
  });
  return indexLoading;
}

// 点のまわり radiusM を覆うタイル（{緯度の番号}_{経度の番号}）
function tilesAround(points, radiusM, size) {
  const keys = new Set();
  for (const p of points) {
    const dy = radiusM / 111320;
    const dx = radiusM / (111320 * Math.cos((p.lat * Math.PI) / 180));
    for (let y = Math.floor((p.lat - dy) / size); y <= Math.floor((p.lat + dy) / size); y++) {
      for (let x = Math.floor((p.lng - dx) / size); x <= Math.floor((p.lng + dx) / size); x++) keys.add(`${y}_${x}`);
    }
  }
  return [...keys];
}

function loadTile(key, chains) {
  if (!tileLoading.has(key)) {
    const p = fetchJson(`data/stores/${key}.json${DATA_V}`, {}, 20000)
      .then((rows) => rows.map(([id, name, c, lat, lng]) => ({ id, name, chain: chains[c], lat, lng })));
    p.catch(() => tileLoading.delete(key));
    tileLoading.set(key, p);
  }
  return tileLoading.get(key);
}

// 前もって作ったデータで探す。範囲外（駅・バス停から遠い所）や読めなかったときは null
async function storesFromData(points, radiusM) {
  const index = await loadStoreIndex().catch((e) => {
    console.warn('店舗データの一覧を読めません', e);
    return null;
  });
  if (!index) return null;
  const keys = tilesAround(points, radiusM, index.tile);
  if (!keys.every((k) => k in index.tiles)) return null;
  try {
    const rows = await Promise.all(keys.filter((k) => index.tiles[k] > 0).map((k) => loadTile(k, index.chains)));
    return rows.flat().filter((s) => points.some((p) => haversine(p, s) <= radiusM));
  } catch (e) {
    console.warn('店舗データを読めないので、Overpass に問い合わせます', e);
    return null;
  }
}

export async function storeDataDate() {
  return (await loadStoreIndex().catch(() => null))?.generatedAt ?? '';
}

// ===== 範囲外だけ公開 Overpass サーバーに問い合わせる =====
// 1 つずつ順に試すと、遅いサーバーの時間切れを待つあいだに失敗していた（2026-09-15 の実測: mail.ru は 11〜18 秒で返るのに 10 秒で打ち切っていた）。
// そこで最初の 2 つに同時に問い合わせて先に返った方を使い、どちらもだめなら残りを試す
const OVERPASS_FIRST = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OVERPASS_REST = ['https://overpass.kumi.systems/api/interpreter'];
const OVERPASS_TIMEOUT = 25000;

async function storesFromOverpass(points, radiusM, { timeoutScale, signal }) {
  const parts = points.map((p) => `nwr["shop"="convenience"](around:${Math.round(radiusM)},${p.lat.toFixed(6)},${p.lng.toFixed(6)});`);
  const query = `[out:json][timeout:${25 * timeoutScale}];(${parts.join('')});out center tags;`;
  const errors = [];
  const ask = (url, sig) => fetchJson(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: sig }, OVERPASS_TIMEOUT * timeoutScale)
    .then((json) => {
      // 混雑時は HTTP 200 のまま remark にエラーが入り、結果が空や途中までになることがある
      if (/runtime error|timed out|rate_limited|out of memory/i.test(json.remark ?? '')) throw new Error(json.remark);
      return dedupe(json.elements.map(toStore).filter(Boolean));
    })
    .catch((e) => {
      console.warn(url, e);
      errors.push(`${new URL(url).hostname}: ${e.name === 'AbortError' ? 'タイムアウト' : e.name === 'TypeError' ? '接続できません' : e.message}`);
      throw e;
    });

  const race = new AbortController();
  const stop = () => race.abort();
  signal?.addEventListener('abort', stop);
  try {
    return await Promise.any(OVERPASS_FIRST.map((url) => ask(url, race.signal)));
  } catch {
    if (signal?.aborted) throw cancelled();
  } finally {
    race.abort(); // 遅かった方の問い合わせを止める
    signal?.removeEventListener('abort', stop);
  }
  for (const url of OVERPASS_REST) {
    if (signal?.aborted) throw cancelled();
    try {
      return await ask(url, signal);
    } catch {
      if (signal?.aborted) throw cancelled();
    }
  }
  throw new Error(`店舗データのサーバーが混雑しています。少し待ってから再検索してください。（${errors.join(' / ')}）`);
}

// 複数の駅それぞれの周り radiusM メートルの店を探す
// timeoutScale: Overpass に問い合わせるとき、広い範囲（エリア検索の半径 10km など）は待ち時間を伸ばす
// signal: 利用者が「中断」を押したら止める（CancelError）
export async function fetchStoresAround(points, radiusM, { timeoutScale = 1, signal } = {}) {
  const found = await storesFromData(points, radiusM);
  if (signal?.aborted) throw cancelled();
  return found ?? storesFromOverpass(points, radiusM, { timeoutScale, signal });
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
