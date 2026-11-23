// Shared app state. Modules import these live bindings; only setters below reassign them.
export let M = null;   // data model (see model.js)
export let map = null; // HockeyMap instance (see map.js)
export const state = { team: null, player: null, stack: [], tab: 'roster', showAllConn: false };
// Navigation actions, filled in by main.js: selectTeam(i, opts), selectPlayer(i, opts), clearSelection(), goBack()
export const actions = {};
export function setModel(m) { M = m; }
export function setMap(m) { map = m; }

// Which sport the page shows: ?sport=football switches the whole app to NFL + NCAA football data.
export const SPORT = new URLSearchParams(location.search).get('sport') === 'football' ? 'football' : 'hockey';
export const APP_NAME = SPORT === 'football' ? 'Football Atlas' : 'Hockey Atlas';
