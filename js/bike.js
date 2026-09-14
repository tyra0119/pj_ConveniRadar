// シェアサイクル（ODPT 経由の GBFS）: ポートの位置・台数と、停留所の間を自転車でつなぐ時間
import { ODPT_SOURCES } from './config.js?v=921e916d';
import { fetchJson, haversine } from './util.js?v=921e916d';

export const BIKE_SYSTEMS = [
  { id: 'docomo-cycle', label: 'ドコモ・バイクシェア' },
  { id: 'hellocycling', label: 'HELLO CYCLING' },
];

const BIKE_SPEED = 250; // 自転車の速さ（m/分 = 15km/h）
const ROAD_FACTOR = 1.3; // 直線距離 → 道のり
const PORT_RADIUS = 500; // 停留所からこの距離以内のポートで借りる・返す
const RENT_MIN = 2; // 借りる手続き（アプリの操作・鍵を外す）
const RETURN_MIN = 1; // 返す手続き
const BIKE_MAX = 10000; // 自転車で走る道のりの上限（m）
const STATUS_MAX_AGE = 60 * 1000; // 台数は GBFS の ttl（60 秒）ごとに取り直す

function gbfsUrl(system, file) {
  const s = ODPT_SOURCES.pub;
  const url = new URL(`${s.base}gbfs/${system}/${file}.json`);
  if (s.key) url.searchParams.set('acl:consumerKey', s.key);
  return url;
}

// ポートの位置は大きい（HELLO CYCLING だけで 7.7MB、2026-09-14）ので、使うときに一度だけ取る
let info = null;
let infoLoading = null;
export function loadBikeInfo() {
  if (info) return Promise.resolve(info);
  infoLoading ??= Promise.all(BIKE_SYSTEMS.map(async (sys) => {
    try {
      const j = await fetchJson(gbfsUrl(sys.id, 'station_information'), {}, 60000);
      return (j.data?.stations ?? []).map((st) => ({
        id: st.station_id,
        system: sys.id,
        systemLabel: sys.label,
        // GBFS v3 では name が [{ text, language }] になる
        name: typeof st.name === 'string' ? st.name : st.name?.[0]?.text ?? '',
        lat: st.lat,
        lon: st.lon,
      }));
    } catch (e) {
      console.warn(sys.id, e);
      return [];
    }
  })).then((lists) => {
    const ports = lists.flat().filter((p) => p.lat != null && p.lon != null);
    if (!ports.length) throw new Error('シェアサイクルのポートを取得できませんでした');
    info = { ports };
    return info;
  });
  infoLoading.catch(() => { infoLoading = null; });
  return infoLoading;
}

let status = null; // { at, byKey: Map "system|station_id" → station_status }
let statusLoading = null;
export function loadBikeStatus() {
  if (status && Date.now() - status.at < STATUS_MAX_AGE) return Promise.resolve(status);
  statusLoading ??= Promise.all(BIKE_SYSTEMS.map(async (sys) => {
    try {
      const j = await fetchJson(gbfsUrl(sys.id, 'station_status'), {}, 60000);
      return (j.data?.stations ?? []).map((st) => [`${sys.id}|${st.station_id}`, st]);
    } catch (e) {
      console.warn(sys.id, e);
      return [];
    }
  })).then((lists) => {
    status = { at: Date.now(), byKey: new Map(lists.flat()) };
    statusLoading = null;
    return status;
  }, (e) => {
    statusLoading = null;
    throw e;
  });
  return statusLoading;
}

// 地点の近くで、借りられる（rent）／返せる（return）ポート。近い順
function portsNear(point, need) {
  const dLat = PORT_RADIUS / 111000;
  const dLng = PORT_RADIUS / (111000 * Math.cos((point.lat * Math.PI) / 180));
  const out = [];
  for (const p of info.ports) {
    if (Math.abs(p.lat - point.lat) > dLat || Math.abs(p.lon - point.lng) > dLng) continue;
    const dist = haversine(point, { lat: p.lat, lng: p.lon });
    if (dist > PORT_RADIUS) continue;
    const st = status.byKey.get(`${p.system}|${p.id}`);
    if (!st || st.is_installed === false) continue;
    const ok = need === 'rent'
      ? st.is_renting !== false && st.num_bikes_available > 0
      : st.is_returning !== false && st.num_docks_available > 0;
    if (ok) out.push({ port: p, dist, bikes: st.num_bikes_available, docks: st.num_docks_available });
  }
  return out.sort((x, y) => x.dist - y.dist);
}

// 地点の近くで、借りられる／返せる事業者（エリア巡回の見積もり用）。loadBikeInfo と loadBikeStatus のあとで使う
export function portAccess(point) {
  if (!info || !status) return { rent: new Set(), ret: new Set() };
  return {
    rent: new Set(portsNear(point, 'rent').map((x) => x.port.system)),
    ret: new Set(portsNear(point, 'return').map((x) => x.port.system)),
  };
}

/**
 * 停留所 a の近くのポートで借り、停留所 b の近くのポートに返す。depart（分）に a を出る。
 * 返り値: { ride: { mode: 'bike', dep, arr, system, rent, ret, walkTo, rideMin, walkFrom, dist } } / { reason }
 */
export async function findBikeRide({ a, b, depart, walkSpeed, walkFactor }) {
  await Promise.all([loadBikeInfo(), loadBikeStatus()]);
  const rents = portsNear(a, 'rent');
  if (!rents.length) return { reason: `${a.name}の近く（${PORT_RADIUS}m 以内）に、借りられる自転車のあるポートがありません` };
  const returns = portsNear(b, 'return');
  if (!returns.length) return { reason: `${b.name}の近く（${PORT_RADIUS}m 以内）に、返せる空きのあるポートがありません` };

  let best = null;
  for (const r of rents.slice(0, 5)) {
    for (const t of returns.slice(0, 5)) {
      if (t.port.system !== r.port.system) continue; // 借りた事業者のポートに返す
      const dist = haversine({ lat: r.port.lat, lng: r.port.lon }, { lat: t.port.lat, lng: t.port.lon }) * ROAD_FACTOR;
      if (dist > BIKE_MAX) continue;
      const walkTo = (r.dist * walkFactor) / walkSpeed;
      const walkFrom = (t.dist * walkFactor) / walkSpeed;
      const total = walkTo + RENT_MIN + dist / BIKE_SPEED + RETURN_MIN + walkFrom;
      if (!best || total < best.total) best = { r, t, dist, walkTo, walkFrom, total };
    }
  }
  if (!best) return { reason: `借りるポートと返すポートが同じ事業者で見つからないか、自転車で ${BIKE_MAX / 1000}km を超えます` };

  return {
    ride: {
      mode: 'bike',
      dep: depart,
      arr: depart + best.total,
      system: best.r.port.systemLabel,
      rent: { name: best.r.port.name, lat: best.r.port.lat, lon: best.r.port.lon, bikes: best.r.bikes },
      ret: { name: best.t.port.name, lat: best.t.port.lat, lon: best.t.port.lon, docks: best.t.docks },
      walkTo: best.walkTo,
      rideMin: best.dist / BIKE_SPEED,
      walkFrom: best.walkFrom,
      dist: best.dist,
    },
  };
}
