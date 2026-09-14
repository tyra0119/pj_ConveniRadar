// ODPT の接続先。
// キーは空のまま置く。tools/serve.py（手元）と tools/publish.py（公開用）が .env の値を差し込む。
// 中継（Cloudflare Workers など）を使うときは .env の ODPT_BASE / ODPT_CHALLENGE_BASE に中継先を書き、キーは中継側に持たせる。
// 「// @名前」は差し込みの目印なので消さないこと（tools/env.py）。
const PUB_BASE = 'https://api.odpt.org/api/v4/'; // @ODPT_BASE
const PUB_KEY = "b0mg7xyln1e8yd2d2uh2z4hea92r4zjphrkqsvmuzjqos1cdxi1ovwgoeoul7g78"; // @ODPT_KEY
const CHL_BASE = 'https://api-challenge.odpt.org/api/v4/'; // @ODPT_CHALLENGE_BASE
const CHL_KEY = "4venni83t6gaq25zkzgkwbp12ttn290qwvydonhs5si6g8mrdvpykjwezplekez9"; // @ODPT_CHALLENGE_KEY
// センター API は通年、チャレンジ API は 2027-03-12 まで。どちらかにしか無いデータがあるので両方引く
export const ODPT_SOURCES = {
  pub: { label: '公共交通オープンデータセンター', base: PUB_BASE, key: PUB_KEY },
  chl: { label: '公共交通オープンデータチャレンジ', base: CHL_BASE, key: CHL_KEY, until: '2027-03-12' },
};

// data/ の JSON に付ける版。tools/publish.py が中身のハッシュに置き換える
export const DATA_V = '?v=7add0f74';
