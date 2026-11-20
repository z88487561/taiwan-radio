const API_BASE = "https://de1.api.radio-browser.info/json";
const CATALOG_LIMIT = 1000;
const PAGE_SIZE = 12;
const TRACK_ROW_HEIGHT = 57;
const TRACK_WINDOW_SIZE = 60;
const FAVORITES_KEY = "island-fm-favorite-stations";
const DIAG_KEY = "island-fm-diag";
const LIBRARY_KEY = "island-fm-last-library";

// ---- 診斷記錄（背景停播時，回到 App 後可在音樂頁最下方複製）----
let diagLines = (() => {
  try { return JSON.parse(localStorage.getItem(DIAG_KEY) || "[]"); } catch { return []; }
})();
function diag(message) {
  diagLines.push(`${new Date().toTimeString().slice(0, 8)} ${message}`);
  if (diagLines.length > 150) diagLines.splice(0, diagLines.length - 150);
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(diagLines)); } catch { /* ignore */ }
  const panel = document.getElementById("diag-panel");
  if (panel?.open) document.getElementById("diag-log").textContent = diagLines.join("\n");
}

// ---- 記住上次的播放清單（瀏覽器無法跨次保留檔案存取權，所以存「清單資訊＋播放位置」，重新選同一資料夾即可接續）----
function trackKey(file) {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}
function readSavedLibrary() {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || "null"); } catch { return null; }
}
function saveLibrary() {
  if (!state.playlist.length) return;
  const track = state.playlist[state.currentTrack];
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({
      count: state.playlist.length,
      current: track ? trackKey(track.file) : null,
      title: track ? track.title : null,
      position: Math.floor(elements["music-audio"].currentTime || 0),
      shuffle: state.shuffle
    }));
  } catch { /* 空間不足時略過 */ }
}
function savedLibraryHint() {
  const saved = readSavedLibrary();
  if (!saved?.count) return "";
  return `上次：${saved.title ? `「${saved.title}」· ` : ""}共 ${saved.count} 首，重新選取同一個資料夾即可接續`;
}
// 重新選取資料夾後：回到上次的那首與播放位置（不自動播放）。回傳 true 表示已開始還原。
function restoreLastSession() {
  if (state.currentTrack >= 0 || state.restoreTried) return false;
  state.restoreTried = true;
  const saved = readSavedLibrary();
  if (!saved?.current) return false;
  const index = state.playlist.findIndex(track => trackKey(track.file) === saved.current);
  if (index < 0) return false;
  const track = state.playlist[index];
  state.currentTrack = index;
  if (typeof saved.shuffle === "boolean") {
    state.shuffle = saved.shuffle;
    elements["shuffle-button"].classList.toggle("active", state.shuffle);
    elements["shuffle-button"].setAttribute("aria-pressed", String(state.shuffle));
  }
  resolveTrackUrl(track).then(url => {
    if (state.currentTrack !== index || state.activePlayer || state.loadingTrack) return;
    const audio = elements["music-audio"];
    const position = Number(saved.position) || 0;
    audio.addEventListener("loadedmetadata", () => {
      if (position > 0 && Number.isFinite(audio.duration) && position < audio.duration - 2) audio.currentTime = position;
      saveLibrary();
    }, { once: true });
    audio.src = url;
    updateNowPlaying(track.title, track.artist || "本地音樂", true);
    elements["track-list"].scrollTop = Math.max(0, index - 8) * TRACK_ROW_HEIGHT;
    renderPlaylist();
    setActivePlayer("music");
    showToast(`已回到上次播放的「${track.title}」，按 ▶ 繼續。`);
  }).catch(error => {
    console.warn("無法還原上次的播放位置：", error);
    state.currentTrack = -1;
    renderPlaylist();
  });
  return true;
}
// ---- 接力播放：歌曲結束前 0.8 秒，由備用 <audio> 先開始播下一首，再停掉舊的 ----
// 讓分頁在換歌的瞬間始終有一個元素在播放，避免背景時因為「播放中斷」而被系統收回音訊焦點/通知。
const HANDOFF_SECONDS = 0.8;
function nativeOpusSupported() {
  return Boolean(document.createElement("audio").canPlayType('audio/ogg; codecs="opus"'));
}
async function armStandby() {
  state.standbyIndex = -1;
  if (state.audioContext) return; // 平衡音量的處理鏈只接在一個元素上，這時沿用原本的換歌流程
  if (state.activePlayer !== "music" || state.currentTrack < 0 || !state.playlist.length) return;
  if (!state.shuffle && state.currentTrack === state.playlist.length - 1) return; // 清單最後一首：自然結束
  const nextIndex = getNextTrackIndex();
  if (nextIndex < 0 || nextIndex === state.currentTrack) return;
  const next = state.playlist[nextIndex];
  if (!next || next.removed) return;
  if (!nativeOpusSupported() && /\.(opus|ogg|oga)$/i.test(next.file.name)) return; // 需要先解碼的檔案不走接力
  const currentIndex = state.currentTrack;
  try {
    if (state.shuffle) state.shuffleNextTrack = nextIndex;
    const url = await getTrackPlaybackUrl(next);
    if (state.currentTrack !== currentIndex || state.audioContext) return;
    const standby = state.standby;
    standby.src = url;
    standby.volume = Number(elements["volume-control"].value);
    standby.load();
    state.standbyIndex = nextIndex;
    diag(`備用就緒 #${nextIndex}`);
  } catch (error) {
    diag(`備用失敗 ${error.message}`);
  }
}
function maybeHandoff() {
  if (state.handingOff || state.standbyIndex < 0 || state.loadingTrack) return;
  const audio = elements["music-audio"];
  if (audio.paused || !Number.isFinite(audio.duration) || audio.duration < 8) return;
  if (audio.duration - audio.currentTime > HANDOFF_SECONDS) return;
  const index = state.standbyIndex;
  if (index !== getNextTrackIndex()) { state.standbyIndex = -1; return; }
  state.handingOff = true;
  const standby = state.standby;
  diag(`接力開始 #${index} 剩 ${(audio.duration - audio.currentTime).toFixed(2)}s ${document.visibilityState}`);
  standby.play().then(() => {
    state.handingOff = false;
    if (elements["music-audio"] !== audio || state.standbyIndex !== index) { standby.pause(); return; }
    finishHandoff(index);
  }).catch(error => {
    state.handingOff = false;
    state.standbyIndex = -1;
    diag(`接力失敗 ${error.name}: ${error.message}`);
    if (audio.ended && elements["music-audio"] === audio && !state.loadingTrack) playNext(true);
  });
}
function finishHandoff(index) {
  const old = elements["music-audio"];
  const fresh = state.standby;
  const previousIndex = state.currentTrack;
  const track = state.playlist[index];
  state.playRequestId += 1;
  clearTimeout(state.preloadTimer);
  state.preloadTimer = null;
  if (previousIndex >= 0 && previousIndex !== index) state.playHistory.push(previousIndex);
  state.currentTrack = index;
  state.shuffleNextTrack = null;
  state.standbyIndex = -1;
  elements["music-audio"] = fresh;
  state.standby = old;
  old.pause();
  old.removeAttribute("src");
  old.load();
  if (previousIndex !== index) releaseTrackSource(previousIndex);
  releaseDecodedTracks(decodedKeepSet(index));
  fresh.volume = Number(elements["volume-control"].value);
  state.activePlayer = "music";
  state.smoothedRms = 0;
  if (Number.isFinite(fresh.duration)) track.duration = fresh.duration;
  updateNowPlaying(track.title, track.artist || "本地音樂", true);
  updateProgress();
  const firstVisible = Math.floor(elements["track-list"].scrollTop / TRACK_ROW_HEIGHT);
  if (index < firstVisible || index >= firstVisible + TRACK_WINDOW_SIZE) {
    elements["track-list"].scrollTop = Math.max(0, index - 8) * TRACK_ROW_HEIGHT;
  }
  renderPlaylist();
  setActivePlayer("music");
  scheduleNextTrackPreload();
  saveLibrary();
  diag(`接力完成 #${index} ${track.title}`);
  armStandby();
}
// 需要解碼 OPUS 時，除了現在這首，往後保留兩首已解碼的
function decodedKeepSet(index) {
  const keep = new Set([index]);
  if (!state.shuffle && state.playlist.length > 1) {
    keep.add((index + 1) % state.playlist.length);
    keep.add((index + 2) % state.playlist.length);
  }
  return keep;
}
const KISS_STATION = {
  stationuuid: "kissradio-fm999-official",
  name: "KISS RADIO 大眾廣播 FM99.9",
  url_resolved: "https://www.kiss.com.tw/test/hichannel2.php?api=1",
  homepage: "https://www.kiss.com.tw/radio_hq.php?fm=999",
  country: "Taiwan, Republic Of China",
  state: "Kaohsiung",
  tags: "高雄,KISS FM99.9,pop",
  clickcount: 0,
  votes: 0,
  externalPlayer: true
};
const RADIOS_TW_STATIONS = [
  ["apple-line-radop", "A-Line Radio 聯播網", "98.7 FM"],
  ["bao-dao-991", "Bao Dao Radio 大千電台", "99.1 FM"],
  ["bao-dao-985", "Bao Dao Radio 寶島新聲", "98.5 FM"],
  ["hit-fm-91-5", "HitFM 聯播網－中部", "91.5 FM", "台中"],
  ["hit-fm-90-1", "HitFM 聯播網－南部", "90.1 FM"],
  ["hit-fm97-1", "HitFM 聯播網－宜蘭", "97.1 FM", "宜蘭"],
  ["icrt", "ICRT", "100.0 FM"],
  ["ic-broadcasting", "IC 之音竹科廣播", "97.5 FM"],
  ["shih-hsin-station", "世新廣播電台", "729 AM"],
  ["bcc-news-network", "中廣新聞網", "657 AM"],
  ["i-like-bcc-pop-network", "中廣流行網", "103.3 FM"],
  ["i-bcc-music-network", "中廣音樂網", "96.3 FM"],
  ["news-98-fm", "九八新聞台", "98.1 FM"],
  ["asia-fm-92-3", "亞洲廣播網－亞太電台", "92.3 FM"],
  ["asia-fm-92-7", "亞洲廣播網－亞洲電台", "92.7 FM"],
  ["good-news-fm", "佳音廣播電台", "90.9 FM"],
  ["mnational-broadcast", "全國廣播", "106.1 FM"],
  ["national-education", "國立教育廣播電臺", "101.7 FM"],
  ["city-fm-92-9", "城市廣播網", "92.9 FM"],
  ["city-fm-98-3", "城市廣播網－大苗栗廣播", "98.3 FM", "苗栗"],
  ["voice-of-hakka", "大漢之音", "97.1 FM"],
  ["sunny", "太陽電台", "89.1 FM"],
  ["best-taichung", "好事903電台", "90.3 FM", "台中"],
  ["best", "好事聯播網", "98.9 FM"],
  ["classical-fm-97-7", "好家庭聯播網－古典音樂台", "97.7 FM"],
  ["bravo-fm", "好家庭聯播網－台北都會音樂台", "91.3 FM", "台北"],
  ["formosa-hakka", "寶島客家電台", "93.7 FM"],
  ["fhbs-1", "復興廣播電台", "558 AM"],
  ["smile-taiwan-tainan", "微微笑廣播網－台南凱旋電台", "97.9 FM", "台南"],
  ["smile-taiwan-happy", "微微笑廣播網－歡喜之聲", "105.5 FM"],
  ["smile-taiwan", "微微笑廣播網－高雄下港之聲", "90.5 FM", "高雄"],
  ["happy-taipei", "快樂聯播網－台北台", "89.3 FM", "台北"],
  ["vnccu", "政大之聲", "88.7 FM", "台北"],
  ["chengsheng-broadcasting-fm-tai", "正聲廣播", "104.1 FM"],
  ["voice-of-han-broadcasting-netw", "漢聲廣播電台", "106.5 FM"],
  ["uni", "環宇廣播電台", "96.7 FM"],
  ["tbs", "臺北廣播電臺", "93.1 FM", "台北"],
  ["pbs-national", "警察廣播電台－全國治安交通網", "104.9 FM"],
  ["police-broadcasting-service-ta", "警察廣播電台－台北台", "94.3 FM", "台北"],
  ["voice-of-fu-jen-catholic-unive", "輔大之聲", "88.5 FM", "新北"],
  ["fly", "飛揚調頻", "89.5 FM"],
  ["ufo", "飛碟聯播網", "92.1 FM"]
];
const TAICHUNG_GOODFM_STATION = {
  stationuuid: "goodfm-taichung-fm903",
  name: "好事聯播網 台中好事",
  homepage: "http://www.bestradio.com.tw/",
  country: "Taiwan, Republic Of China",
  state: "台中",
  tags: "台中,好事聯播網",
  frequency: 90.3,
  radiosSlug: "best-taichung",
  clickcount: 0,
  votes: 0,
  externalPlayer: true,
  officialPage: true
};
const cities = [
  "台北", "新北", "基隆", "桃園", "新竹", "苗栗", "台中", "彰化", "南投",
  "雲林", "嘉義", "台南", "高雄", "屏東", "宜蘭", "花蓮", "台東", "澎湖",
  "金門", "馬祖"
];
const popularWords = ["icrt", "hit fm", "ufo", "news98", "好事", "飛碟", "中廣", "警察", "警廣", "kiss", "寶島", "古典", "漢聲", "教育廣播", "原住民"];

const elements = Object.fromEntries([
  "radio-audio", "music-audio", "station-grid", "station-count", "station-search",
  "city-filter", "station-sort", "catalog-message", "empty-state", "load-more", "connection-text",
  "view-breadcrumb", "radio-view", "music-view", "file-input", "folder-input",
  "pick-files", "pick-folder", "track-list", "playlist-count", "playlist-subtitle",
  "shuffle-button", "balance-button", "previous-button", "play-button", "play-icon",
  "next-button", "stop-button", "seek-bar", "current-time", "duration-time",
  "volume-control", "volume-value", "now-title", "now-subtitle", "cover-art",
  "playing-live", "toast", "install-button", "official-player-dialog",
  "official-player-kicker", "official-player-title", "official-player-frame", "close-official-player", "official-player-hint",
  "official-player-link"
].map(id => [id, document.getElementById(id)]));

function readFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    if (Array.isArray(stored) && stored.every(id => typeof id === "string")) return new Set(stored);
    console.warn("已忽略格式不正確的最愛電台資料。");
  } catch (error) {
    console.warn("無法讀取最愛電台資料：", error);
  }
  return new Set();
}

const state = {
  stations: [],
  category: "all",
  query: "",
  city: "all",
  sort: "clickcount",
  favorites: readFavorites(),
  visibleCount: PAGE_SIZE,
  activeStation: null,
  activePlayer: null,
  playlist: [],
  playlistStart: 0,
  currentTrack: -1,
  radioRequestId: 0,
  radioSourceCache: new Map(),
  hlsPlayer: null,
  externalPlayerOpen: false,
  playRequestId: 0,
  loadingTrack: false,
  opusDecoderPromise: null,
  shuffleNextTrack: null,
  preloadTimer: null,
  preloadPromise: null,
  gainTimer: null,
  gainBuffer: null,
  smoothedRms: 0,
  shuffle: false,
  balance: false,
  audioContext: null,
  objectUrls: [],
  playHistory: [],
  toastTimeout: null,
  installPrompt: null,
  directoryLoaded: false,
  kissChannel: "lh"
};

function stationId(station) {
  return station.stationuuid || (station.radiosSlug
    ? `radios-tw-${station.radiosSlug}`
    : `${station.name}|${station.url_resolved}`);
}

function getStationCity(station) {
  const search = `${station.name || ""} ${station.tags || ""} ${station.state || ""} ${station.homepage || ""}`.replace(/臺/g, "台").toLowerCase();
  return cities.find(city => search.includes(city.toLowerCase())) || "";
}

function getStationFrequency(station) {
  const declaredFrequency = Number(station.frequency);
  const hasAmFrequency = /\bAM\b/i.test(`${station.signal || ""} ${station.name || ""} ${station.tags || ""}`);
  if (Number.isFinite(declaredFrequency) &&
      (hasAmFrequency ? declaredFrequency >= 500 && declaredFrequency <= 1800 : declaredFrequency >= 76 && declaredFrequency <= 108)) {
    return declaredFrequency.toFixed(hasAmFrequency ? 0 : 1);
  }
  const match = `${station.signal || ""} ${station.name || ""} ${station.tags || ""}`.match(/(\d{2,4}(?:\.\d{1,2})?)\s*(FM|AM)\b|\b(FM|AM)\s*(\d{2,4}(?:\.\d{1,2})?)/i);
  const band = (match?.[2] || match?.[3] || "").toUpperCase();
  const value = Number(match?.[1] || match?.[4]);
  return Number.isFinite(value) &&
      (band === "AM" ? value >= 500 && value <= 1800 : value >= 76 && value <= 108)
    ? value.toFixed(band === "AM" ? 0 : 1)
    : "";
}

function getStationDisplayName(station) {
  const frequency = getStationFrequency(station);
  if (!frequency || (station.name || "").includes(frequency)) {
    return station.name;
  }
  const band = /\bAM\b/i.test(`${station.signal || ""} ${station.name || ""} ${station.tags || ""}`) ? "AM" : "FM";
  return `${station.name} · ${band} ${frequency}`;
}

function stationCategory(station) {
  const name = `${station.name || ""} ${station.tags || ""}`.toLowerCase();
  if (/警察|警廣|police/.test(name)) return "police";
  if (getStationCity(station)) return "regional";
  if (popularWords.some(word => name.includes(word))) return "popular";
  return "other";
}

function isPopularStation(station) {
  const name = `${station.name || ""} ${station.tags || ""}`.toLowerCase();
  return popularWords.some(word => name.includes(word));
}

function initials(name) {
  const clean = (name || "FM").replace(/[\s\-|｜].*$/, "").trim();
  return Array.from(clean).slice(0, 2).join("") || "FM";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function getFilteredStations() {
  const query = state.query.trim().toLocaleLowerCase();
  return state.stations.filter(station => {
    const category = stationCategory(station);
    const text = `${getStationDisplayName(station)} ${station.name || ""} ${station.tags || ""} ${station.homepage || ""}`.toLocaleLowerCase();
    return (state.category === "all" ||
      (state.category === "regional" && category === "regional") ||
      (state.category === "popular" && (category === "popular" || isPopularStation(station))) ||
      (state.category === "police" && category === "police") ||
      (state.category === "favorites" && state.favorites.has(stationId(station)))) &&
      (state.city === "all" || getStationCity(station) === state.city) &&
      (!query || text.includes(query));
  });
}

function renderStations() {
  const filtered = getFilteredStations().sort((a, b) => {
    if (state.sort === "name") return a.name.localeCompare(b.name, "zh-TW");
    if (Boolean(a.radiosSlug) !== Boolean(b.radiosSlug)) return a.radiosSlug ? -1 : 1;
    return (Number(b.clickcount) || 0) - (Number(a.clickcount) || 0) ||
      (Number(b.votes) || 0) - (Number(a.votes) || 0) ||
      a.name.localeCompare(b.name, "zh-TW");
  });
  const shown = filtered.slice(0, state.visibleCount);
  elements["station-count"].textContent = state.stations.length ? state.stations.length.toLocaleString("zh-TW") : "—";
  elements["station-grid"].innerHTML = shown.map((station, index) => {
    const city = getStationCity(station);
    const category = stationCategory(station);
    const displayName = getStationDisplayName(station);
    const tags = (station.tags || "").split(",").map(tag => tag.trim()).filter(Boolean);
    const stationTag = tags.find(tag => tag.replace(/臺/g, "台").toLowerCase() !== city.toLowerCase());
    const meta = city ? `${city} · ${stationTag || "在地電台"}` : (stationTag || "台灣網路電台");
    const playing = state.activeStation && stationId(state.activeStation) === stationId(station);
    const favorite = state.favorites.has(stationId(station));
    const popularity = station.externalPlayer ? "官方直播" : station.radiosSlug
      ? "Radios.tw 電台"
      : `${Number(station.clickcount) || 0} 次收聽`;
    return `<article class="station-card${playing ? " is-playing" : ""}">
      <div class="station-logo" data-tone="${index % 4}">${escapeHtml(initials(station.name))}</div>
      <div class="station-info">
        <strong class="station-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</strong>
        <span class="station-meta" title="${station.externalPlayer ? "官方播放器" : station.radiosSlug ? "電台資訊與播放來源：Radios.tw" : `Radio Browser 目錄點擊次數：${Number(station.clickcount) || 0}`}">${escapeHtml(category === "police" ? "警察廣播電台" : meta)} · ${escapeHtml(popularity)}</span>
      </div>
      <button class="favorite-button${favorite ? " is-favorite" : ""}" type="button" data-favorite="${escapeHtml(stationId(station))}" aria-label="${favorite ? "從最愛移除" : "加入最愛"} ${escapeHtml(displayName)}" aria-pressed="${favorite}" title="${favorite ? "從最愛移除" : "加入最愛"}">${favorite ? "♥" : "♡"}</button>
      <button class="station-play" type="button" data-station="${escapeHtml(stationId(station))}" aria-label="${playing ? "停止" : "播放"} ${escapeHtml(displayName)}" title="${playing ? "停止播放" : "播放"}">${playing ? "Ⅱ" : "▶"}</button>
    </article>`;
  }).join("");
  elements["empty-state"].hidden = shown.length > 0;
  elements["load-more"].hidden = filtered.length <= shown.length;
  elements["station-grid"].querySelectorAll(".station-play").forEach(button => {
    button.addEventListener("click", () => {
      const station = state.stations.find(item => stationId(item) === button.dataset.station);
      if (!station) return;
      if (state.activeStation && stationId(state.activeStation) === stationId(station)) stopAll();
      else playStation(station);
    });
  });
  elements["station-grid"].querySelectorAll(".favorite-button").forEach(button => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favorite));
  });
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
  } catch (error) {
    console.error("無法儲存最愛電台：", error);
    showToast("最愛電台儲存失敗，請檢查瀏覽器儲存空間設定。");
  }
  renderStations();
}

function updateCityFilter() {
  const current = state.city;
  const available = [...new Set(state.stations.map(getStationCity).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-TW"));
  elements["city-filter"].innerHTML = `<option value="all">所有縣市</option>` +
    available.map(city => `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`).join("");
  if (available.includes(current)) elements["city-filter"].value = current;
  else state.city = "all";
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function radiosTwStation(entry) {
  const frequency = Number((entry[2].match(/\d{2,4}(?:\.\d{1,2})?/) || [])[0]);
  const city = entry[3] || "";
  return {
    stationuuid: `radios-tw-${entry[0]}`,
    name: entry[1],
    url_resolved: "",
    homepage: `https://radios.tw/${entry[0]}/`,
    country: "Taiwan, Republic Of China",
    state: city,
    tags: [city, entry[2], /警察/.test(entry[1]) ? "police" : ""].filter(Boolean).join(","),
    signal: entry[2],
    frequency,
    radiosSlug: entry[0],
    clickcount: 0,
    votes: 0
  };
}

function stationNameKey(name) {
  return (name || "").toLowerCase().replace(/臺/g, "台")
    .replace(/radio|fm|am|電台|廣播|聯播網|網路|台灣|[\d.]+|[^\p{L}\p{N}]/gu, "");
}

function isSameRadiosStation(station, radiosStation) {
  const stationKey = stationNameKey(station.name);
  const radiosKey = stationNameKey(radiosStation.name);
  if (stationKey && stationKey === radiosKey) return true;
  const stationFrequency = getStationFrequency(station);
  const radiosFrequency = getStationFrequency(radiosStation);
  return stationFrequency !== "" && stationFrequency === radiosFrequency &&
    stationKey.length >= 2 && radiosKey.length >= 2 &&
    (stationKey.includes(radiosKey) || radiosKey.includes(stationKey));
}

function mergeRadiosTwStations(stations) {
  const merged = [...stations];
  for (const entry of RADIOS_TW_STATIONS) {
    const radiosStation = radiosTwStation(entry);
    const existing = merged.find(station => isSameRadiosStation(station, radiosStation));
    if (existing) {
      existing.radiosSlug = entry[0];
      existing.frequency ||= radiosStation.frequency;
      existing.signal ||= radiosStation.signal;
      if (!getStationCity(existing) && radiosStation.state) existing.state = radiosStation.state;
      continue;
    }
    merged.push(radiosStation);
  }
  const unique = [];
  for (const station of merged) {
    const key = stationNameKey(station.name);
    const frequency = getStationFrequency(station);
    const city = getStationCity(station);
    const duplicate = key
      ? unique.find(candidate => {
        const candidateFrequency = getStationFrequency(candidate);
        const candidateCity = getStationCity(candidate);
        return (candidate.radiosSlug || station.radiosSlug) &&
          stationNameKey(candidate.name) === key &&
          (!frequency || !candidateFrequency || candidateFrequency === frequency) &&
          (!city || !candidateCity || city === candidateCity);
      })
      : null;
    if (!duplicate) {
      unique.push(station);
      continue;
    }
    duplicate.radiosSlug ||= station.radiosSlug;
    duplicate.frequency ||= station.frequency;
    duplicate.signal ||= station.signal;
    if (!duplicate.url_resolved && station.url_resolved) duplicate.url_resolved = station.url_resolved;
    if (!duplicate.homepage && station.homepage) duplicate.homepage = station.homepage;
    if (!getStationCity(duplicate) && getStationCity(station)) duplicate.state = station.state;
    duplicate.clickcount = Math.max(Number(duplicate.clickcount) || 0, Number(station.clickcount) || 0);
    duplicate.votes = Math.max(Number(duplicate.votes) || 0, Number(station.votes) || 0);
  }
  return unique;
}

async function getRadioSources(station) {
  if (station.radiosSlug) {
    if (!state.radioSourceCache.has(station.radiosSlug)) {
      const request = fetch(`https://api.instant.audio/data/streams/142/${encodeURIComponent(station.radiosSlug)}`)
        .then(async response => {
          if (!response.ok) throw new Error(`Radios.tw 回應錯誤（${response.status}）`);
          const data = await response.json();
          if (data.success !== true || !Array.isArray(data.result?.streams)) {
            throw new Error("Radios.tw 沒有提供此電台的播放來源。");
          }
          return data.result.streams
            .filter(stream => stream.url && (
              stream.mediaType === "HLS" ||
              (!stream.isContainer && /^audio\//i.test(stream.mime || ""))
            ))
            .map(stream => ({
              url: stream.url,
              mime: stream.mime || "",
              type: stream.mediaType === "HLS" ? "HLS" : "DIRECT"
            }));
        })
        .catch(error => {
          state.radioSourceCache.delete(station.radiosSlug);
          throw error;
        });
      state.radioSourceCache.set(station.radiosSlug, request);
    }
    try {
      const sources = await state.radioSourceCache.get(station.radiosSlug);
      if (sources.length) return sources;
    } catch (error) {
      console.warn(`無法載入 ${station.name} 的 Radios.tw 播放來源：`, error);
    }
  }
  return station.url_resolved ? [{ url: station.url_resolved, mime: "", type: "DIRECT" }] : [];
}

async function loadStations() {
  elements["connection-text"].textContent = "正在連線電台目錄";
  elements["catalog-message"].hidden = true;
  const queries = [
    fetch(apiUrl(`/stations/bycountrycodeexact/TW?limit=${CATALOG_LIMIT}&hidebroken=true&order=votes&reverse=true`)),
    fetch(apiUrl("/stations/byname/Police?limit=100")),
    fetch(apiUrl("/stations/byname/%E8%AD%A6%E5%AF%9F%E5%BB%A3%E6%92%AD%E9%9B%BB%E5%8F%B0?limit=100")),
    fetch(apiUrl("/stations/byname/%E8%AD%A6%E5%BB%A3?limit=100"))
  ];
  try {
    const responses = await Promise.all(queries.map(request => request
      .then(response => ({ response }))
      .catch(error => ({ error }))));
    const primary = responses[0];
    if (primary.error || !primary.response.ok) {
      throw new Error(primary.error?.message || `電台目錄回應錯誤（${primary.response.status}）`);
    }
    const resultSets = await Promise.all(responses.map(async (result, index) => {
      if (result.error || !result.response.ok) {
        console.warn(`載入${index === 0 ? "主要" : "補充"}電台目錄失敗：`, result.error || result.response.status);
        return [];
      }
      return result.response.json();
    }));
    const deduplicated = new Map();
    for (const station of resultSets.flat()) {
      if (!station.name || !station.url_resolved || station.lastcheckok === 0) continue;
      deduplicated.set(stationId(station), station);
    }
    const stations = mergeRadiosTwStations([
      ...[...deduplicated.values()].filter(station =>
        !(getStationFrequency(station) === "99.9" && /kiss/i.test(station.name))
      ),
      KISS_STATION
    ]);
    const hasGoodFM903 = stations.some(station =>
      getStationFrequency(station) === "90.3" && /好事/.test(`${station.name} ${station.tags}`)
    );
    if (!hasGoodFM903) stations.push(TAICHUNG_GOODFM_STATION);
    if (!stations.length) throw new Error("電台目錄目前沒有提供可播放的台灣電台。");
    state.stations = stations;
    updateCityFilter();
    renderStations();
    elements["connection-text"].textContent = "電台目錄已連線";
    elements["catalog-message"].hidden = true;
  } catch (error) {
    console.error("載入電台目錄失敗：", error);
    state.stations = mergeRadiosTwStations([TAICHUNG_GOODFM_STATION, KISS_STATION]);
    updateCityFilter();
    renderStations();
    elements["connection-text"].textContent = "已載入 Radios.tw 電台清單";
    elements["catalog-message"].innerHTML = `Radio Browser 暫時無法連線：${escapeHtml(error.message)}；目前顯示 Radios.tw 整理的電台。<button type="button" id="retry-catalog">重試</button>`;
    elements["catalog-message"].hidden = false;
    document.getElementById("retry-catalog").addEventListener("click", loadStations);
  }
}

function setActivePlayer(player) {
  state.activePlayer = player;
  const activeAudio = player === "radio" ? elements["radio-audio"] : player === "music" ? elements["music-audio"] : null;
  elements["play-icon"].textContent = activeAudio && !activeAudio.paused ? "Ⅱ" : "▶";
  elements["play-button"].title = activeAudio && !activeAudio.paused ? "暫停" : "播放";
  elements["play-button"].setAttribute("aria-label", elements["play-button"].title);
  const isLive = player === "radio" && Boolean(state.activeStation);
  elements["playing-live"].hidden = !isLive;
  elements["seek-bar"].disabled = player !== "music" || !Number.isFinite(elements["music-audio"].duration);
  if (player === "radio") {
    elements["current-time"].textContent = "LIVE";
    elements["duration-time"].textContent = "LIVE";
    elements["seek-bar"].value = "0";
  } else if (player === "music") {
    updateProgress();
  } else {
    elements["current-time"].textContent = "0:00";
    elements["duration-time"].textContent = "0:00";
    elements["seek-bar"].value = "0";
    elements["seek-bar"].disabled = true;
  }
  syncMediaSession();
}

function updateNowPlaying(title, subtitle, music = false) {
  elements["now-title"].textContent = title;
  elements["now-subtitle"].textContent = subtitle;
  elements["cover-art"].classList.toggle("is-music", music);
  syncMediaSession();
}

// ---- 系統媒體控制（狀態列 / 鎖定畫面通知）----
function setMediaAction(action, handler) {
  try {
    navigator.mediaSession.setActionHandler(action, handler ? (...args) => { diag(`系統控制 ${action}`); return handler(...args); } : null);
  } catch { /* 瀏覽器不支援該動作 */ }
}

function syncMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  const player = state.activePlayer;
  const isMusic = player === "music";
  const audio = player === "radio" ? elements["radio-audio"] : isMusic ? elements["music-audio"] : null;

  if (player && typeof MediaMetadata === "function") {
    const title = elements["now-title"].textContent;
    const artist = elements["now-subtitle"].textContent;
    const key = `${title}\n${artist}`;
    if (state.mediaKey !== key) {
      state.mediaKey = key;
      try {
        session.metadata = new MediaMetadata({
          title,
          artist,
          album: "島聲 FM",
          artwork: [{ src: "./icon.svg", sizes: "any", type: "image/svg+xml" }]
        });
      } catch { /* ignore */ }
    }
  } else if (!player) {
    state.mediaKey = null;
    session.metadata = null;
  }

  session.playbackState = !audio ? "none" : audio.paused ? "paused" : "playing";

  const canSkip = isMusic && state.playlist.length > 0;
  setMediaAction("play", player ? () => { if (audio.paused) togglePlayback(); } : null);
  setMediaAction("pause", player ? () => { if (!audio.paused) togglePlayback(); } : null);
  setMediaAction("stop", player ? stopAll : null);
  setMediaAction("previoustrack", canSkip ? playPrevious : null);
  setMediaAction("nexttrack", canSkip ? () => playNext() : null);
  setMediaAction("seekto", isMusic ? details => {
    const music = elements["music-audio"];
    if (details && Number.isFinite(details.seekTime) && Number.isFinite(music.duration)) {
      music.currentTime = Math.max(0, Math.min(details.seekTime, music.duration));
    }
  } : null);
  if (!isMusic) {
    try { session.setPositionState(); } catch { /* ignore */ }
  }
}

function updateMediaPosition() {
  if (!("mediaSession" in navigator) || state.activePlayer !== "music") return;
  const audio = elements["music-audio"];
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const second = Math.floor(audio.currentTime);
  if (state.mediaPositionSecond === second) return;
  state.mediaPositionSecond = second;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch { /* ignore */ }
  if (second % 5 === 0) saveLibrary();
}

// 背景/鎖屏時 AudioContext 可能被瀏覽器暫停，音訊經過它就會變成沒聲音
function resumeAudioContext() {
  const context = state.audioContext;
  if (!context || context.state === "running") return;
  if (state.activePlayer === "music" && !elements["music-audio"].paused) {
    context.resume().catch(() => {});
  }
}
document.addEventListener("visibilitychange", resumeAudioContext);

async function playStation(station) {
  if (station.externalPlayer) {
    stopRadio();
    stopMusic(false);
    state.activeStation = station;
    state.activePlayer = null;
    state.externalPlayerOpen = true;
    const isGoodFM = station.officialPage === true;
    updateNowPlaying(getStationDisplayName(station), isGoodFM
      ? "台中 FM90.3 · 好事聯播網官方播放器"
      : "高雄 FM99.9 · 官方直播播放器");
    renderStations();
    if (isGoodFM) setGoodFMPlayer();
    else setKissChannel(state.kissChannel);
    elements["official-player-dialog"].showModal();
    return;
  }
  stopRadio();
  stopMusic(false);
  const requestId = state.radioRequestId;
  const audio = elements["radio-audio"];
  state.activeStation = station;
  updateNowPlaying(getStationDisplayName(station), "台灣網路廣播 · 直播中");
  renderStations();
  const sources = await getRadioSources(station);
  if (requestId !== state.radioRequestId) return;
  if (!sources.length) {
    openRadiosTwFallback(station);
    return;
  }
  for (const source of sources) {
    try {
      await playRadioSource(source);
      if (requestId !== state.radioRequestId) return;
      state.externalPlayerOpen = false;
      setActivePlayer("radio");
      return;
    } catch (error) {
      console.warn(`無法播放 ${station.name} 的 ${source.type} 串流：`, error);
    }
  }
  if (station.radiosSlug) {
    openRadiosTwFallback(station);
    showToast("電台串流無法播放，已提供 Radios.tw 與官方收聽頁面。");
    return;
  }
  state.activeStation = null;
  setActivePlayer(null);
  renderStations();
  updateNowPlaying("無法播放這個電台", "請稍後再試，或選擇其他電台");
  showToast("電台播放失敗，可能是串流暫時離線或瀏覽器不支援此格式。");
}

function destroyHlsPlayer() {
  if (!state.hlsPlayer) return;
  state.hlsPlayer.destroy();
  state.hlsPlayer = null;
}

async function playRadioSource(source) {
  const audio = elements["radio-audio"];
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  destroyHlsPlayer();
  audio.volume = Number(elements["volume-control"].value);
  if (source.type === "HLS" &&
      !audio.canPlayType(source.mime || "application/vnd.apple.mpegurl") &&
      window.Hls?.isSupported()) {
    const hls = new window.Hls();
    state.hlsPlayer = hls;
    await new Promise((resolve, reject) => {
      hls.once(window.Hls.Events.MANIFEST_PARSED, () => {
        audio.play().then(resolve, reject);
      });
      hls.once(window.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) reject(new Error("HLS 串流載入失敗。"));
      });
      hls.loadSource(source.url);
      hls.attachMedia(audio);
    });
    return;
  }
  if (source.type === "HLS" && !audio.canPlayType(source.mime || "application/vnd.apple.mpegurl")) {
    throw new Error("此瀏覽器不支援 HLS 播放。");
  }
  audio.src = source.url;
  await audio.play();
}

function openRadiosTwFallback(station) {
  stopRadio();
  stopMusic(false);
  state.activeStation = station;
  state.externalPlayerOpen = true;
  state.activePlayer = null;
  updateNowPlaying(getStationDisplayName(station), station.radiosSlug === "best-taichung"
    ? "台中 FM90.3 · 好事聯播網官方播放器"
    : "請透過 Radios.tw 或電台官網收聽");
  renderStations();
  setRadiosTwFallback(station);
  elements["official-player-dialog"].showModal();
}

function setRadiosTwFallback(station) {
  if (station.radiosSlug === "best-taichung") {
    setGoodFMPlayer();
    return;
  }
  const radiosPage = station.radiosSlug
    ? `https://radios.tw/${station.radiosSlug}/`
    : station.homepage;
  elements["official-player-kicker"].textContent = "RADIOS.TW BACKUP";
  elements["official-player-title"].textContent = `${getStationDisplayName(station)} · 收聽選項`;
  elements["official-player-frame"].src = "about:blank";
  elements["official-player-frame"].hidden = true;
  document.querySelector(".kiss-channel-picker").hidden = true;
  elements["official-player-hint"].textContent = "這個電台沒有可直接播放的串流，或目前串流無法連線。請前往 Radios.tw 電台頁，使用其收聽選項。";
  elements["official-player-link"].href = radiosPage;
  elements["official-player-link"].innerHTML = "開啟 Radios.tw 電台頁 <span aria-hidden=\"true\">↗</span>";
}

function setGoodFMPlayer() {
  elements["official-player-kicker"].textContent = "OFFICIAL LIVE STREAM";
  elements["official-player-title"].textContent = "好事聯播網官方播放器";
  elements["official-player-frame"].src = "about:blank";
  elements["official-player-frame"].hidden = true;
  elements["official-player-hint"].textContent = "好事聯播網會在官方播放器中更新有效串流網址。開啟後，請選擇「好事903電台」開始收聽。";
  elements["official-player-link"].href = "http://www.bestradio.com.tw/link.aspx";
  elements["official-player-link"].innerHTML = "開啟好事聯播網官方播放器並選擇 903 <span aria-hidden=\"true\">↗</span>";
  document.querySelector(".kiss-channel-picker").hidden = true;
}

function setKissChannel(channel) {
  const pageUrl = `https://www.kiss.com.tw/radio_hq.php?fm=999&player=${channel}`;
  const channelName = channel === "lh" ? "官方頻道一" : "官方頻道二";
  elements["official-player-kicker"].textContent = "OFFICIAL LIVE STREAM";
  elements["official-player-title"].textContent = "KISS RADIO FM99.9";
  elements["official-player-frame"].hidden = false;
  document.querySelector(".kiss-channel-picker").hidden = false;
  elements["official-player-frame"].src = pageUrl;
  elements["official-player-hint"].textContent = `使用 KISS RADIO ${channelName}；若播放器未載入，可改用新分頁開啟。`;
  elements["official-player-link"].href = pageUrl;
  elements["official-player-link"].innerHTML = `在新分頁開啟 KISS RADIO ${channelName} <span aria-hidden="true">↗</span>`;
  document.querySelectorAll("[data-kiss-channel]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.kissChannel === channel));
  });
}

function stopRadio() {
  state.radioRequestId += 1;
  const audio = elements["radio-audio"];
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  destroyHlsPlayer();
  state.activeStation = null;
  state.externalPlayerOpen = false;
  if (state.activePlayer === "radio") state.activePlayer = null;
  renderStations();
}

function stopMusic(resetPosition = true) {
  state.playRequestId += 1;
  const wasLoading = state.loadingTrack;
  state.loadingTrack = false;
  clearTimeout(state.preloadTimer);
  state.preloadTimer = null;
  stopTrackGainNormalization();
  elements["previous-button"].disabled = false;
  elements["next-button"].disabled = false;
  const audio = elements["music-audio"];
  audio.pause();
  if (resetPosition && Number.isFinite(audio.duration)) audio.currentTime = 0;
  audio.removeAttribute("src");
  audio.load();
  state.standbyIndex = -1;
  if (state.standby) {
    state.standby.pause();
    state.standby.removeAttribute("src");
    state.standby.load();
  }
  releaseTrackSource(state.currentTrack);
  if (state.activePlayer === "music") state.activePlayer = null;
  if (resetPosition) updateProgress();
  if (wasLoading) renderPlaylist();
}

function stopAll() {
  if (elements["official-player-dialog"].open) elements["official-player-dialog"].close();
  stopRadio();
  stopMusic(true);
  setActivePlayer(null);
  updateNowPlaying("準備好開始收聽了嗎？", "選一個電台，或播放你的音樂");
  renderPlaylist();
}

function initializeAudioProcessing() {
  if (state.audioContext || !window.AudioContext) return;
  try {
    const context = new AudioContext();
    const source = context.createMediaElementSource(elements["music-audio"]);
    const analyser = context.createAnalyser();
    const compressor = context.createDynamicsCompressor();
    const limiter = context.createDynamicsCompressor();
    const levelGain = context.createGain();
    analyser.fftSize = 2048;
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = state.balance ? 2.5 : 1;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.28;
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    source.connect(analyser).connect(compressor).connect(levelGain).connect(limiter).connect(context.destination);
    context.onstatechange = () => {
      diag(`AudioContext ${context.state}`);
      resumeAudioContext();
    };
    state.audioContext = context;
    state.analyser = analyser;
    state.compressor = compressor;
    state.levelGain = levelGain;
    state.gainBuffer = new Float32Array(analyser.fftSize);
  } catch (error) {
    console.error("無法啟用音量平衡：", error);
    state.balance = false;
    elements["balance-button"].classList.remove("active");
    elements["balance-button"].setAttribute("aria-pressed", "false");
    showToast("此瀏覽器無法啟用音量平衡，仍可正常播放音樂。");
  }
}

function updateTrackGain() {
  if (!state.balance || !state.analyser || !state.levelGain || !state.audioContext) return;
  state.analyser.getFloatTimeDomainData(state.gainBuffer);
  let sum = 0;
  for (const sample of state.gainBuffer) sum += sample * sample;
  const rms = Math.sqrt(sum / state.gainBuffer.length);
  if (rms > 0.003) {
    state.smoothedRms = state.smoothedRms > 0
      ? state.smoothedRms * 0.75 + rms * 0.25
      : rms;
    const targetGain = Math.max(0.35, Math.min(4, 0.14 / state.smoothedRms));
    const timeConstant = targetGain < state.levelGain.gain.value ? 0.12 : 0.5;
    state.levelGain.gain.setTargetAtTime(targetGain, state.audioContext.currentTime, timeConstant);
  }
}

function startTrackGainNormalization() {
  if (!state.balance || state.gainTimer) return;
  state.gainTimer = window.setInterval(updateTrackGain, 200);
}

function stopTrackGainNormalization() {
  if (!state.gainTimer) return;
  clearInterval(state.gainTimer);
  state.gainTimer = null;
}

function setTrackGainNormalization(enabled) {
  if (state.compressor && state.audioContext) {
    state.compressor.ratio.setTargetAtTime(enabled ? 2.5 : 1, state.audioContext.currentTime, 0.08);
  }
  if (enabled) {
    state.smoothedRms = 0;
    startTrackGainNormalization();
    return;
  }
  stopTrackGainNormalization();
  if (state.levelGain && state.audioContext) {
    state.levelGain.gain.setTargetAtTime(1, state.audioContext.currentTime, 0.08);
  }
}

function playTrack(index, remember = true) {
  if (index < 0 || index >= state.playlist.length) return;
  if (state.loadingTrack) {
    showToast("上一首仍在準備中，請稍候再切換。");
    return;
  }
  const previousIndex = state.currentTrack;
  const requestId = ++state.playRequestId;
  state.loadingTrack = true;
  state.pendingTrackIndex = index;
  elements["previous-button"].disabled = true;
  elements["next-button"].disabled = true;
  if (state.activeStation || state.activePlayer === "radio" || elements["radio-audio"].getAttribute("src")) stopRadio();
  const track = state.playlist[index];
  const audio = elements["music-audio"];
  // 只有開啟平衡音量才建立 Web Audio；建立後音訊會一直經過它，背景/鎖屏時可能被系統暫停
  if (state.balance) initializeAudioProcessing();
  if (state.audioContext && state.audioContext.state === "suspended") state.audioContext.resume().catch(error => {
    console.error("無法啟用音訊播放：", error);
  });
  let started = false;
  const resolveStarted = performance.now();
  diag(`切歌 #${index} ${track.file.name} (${(track.file.size / 1048576).toFixed(1)}MB, ${track.file.type || "?"})`);
  const alreadyPrepared = Boolean(track.decodedUrl || track.sourceUrl);
  if (previousIndex < 0 && !alreadyPrepared) showToast("正在準備音樂…");
  resolveTrackUrl(track).then(url => {
    if (requestId !== state.playRequestId) return;
    diag(`檔案就緒 ${Math.round(performance.now() - resolveStarted)}ms ${track.decodedUrl ? "已解碼WAV" : "原生播放"} ${document.visibilityState}`);
    if (remember && previousIndex >= 0 && previousIndex !== index) state.playHistory.push(previousIndex);
    state.currentTrack = index;
    state.shuffleNextTrack = null;
    releaseDecodedTracks(decodedKeepSet(index));
    state.loadingTrack = false;
    elements["previous-button"].disabled = false;
    elements["next-button"].disabled = false;
    // 直接換 src，不先 pause/清空/load：背景時中斷播放階段可能讓系統回收音訊
    audio.src = url;
    if (previousIndex !== index) releaseTrackSource(previousIndex);
    audio.volume = Number(elements["volume-control"].value);
    if (state.levelGain && state.audioContext) {
      state.levelGain.gain.setTargetAtTime(1, state.audioContext.currentTime, 0.08);
    }
    updateNowPlaying(track.title, track.artist || "本地音樂", true);
    state.activePlayer = "music";
    state.smoothedRms = 0;
    const firstVisible = Math.floor(elements["track-list"].scrollTop / TRACK_ROW_HEIGHT);
    const visibleEnd = firstVisible + TRACK_WINDOW_SIZE;
    if (index < firstVisible || index >= visibleEnd) {
      elements["track-list"].scrollTop = Math.max(0, index - 8) * TRACK_ROW_HEIGHT;
    }
    renderPlaylist();
    setActivePlayer("music");
    started = true;
    return audio.play();
  }).then(() => {
    if (requestId === state.playRequestId) {
      diag("play() 成功");
      setActivePlayer("music");
      startTrackGainNormalization();
      scheduleNextTrackPreload();
      saveLibrary();
      armStandby();
    }
  }).catch(error => {
    if (requestId !== state.playRequestId) return;
    console.error("無法播放本地音樂：", error);
    diag(`play() 失敗 ${error.name}: ${error.message} ${document.visibilityState}`);
    state.loadingTrack = false;
    elements["previous-button"].disabled = false;
    elements["next-button"].disabled = false;
    // 已經換了 src 但 play() 被拒絕時，保留通知（變成暫停），讓你能從通知按播放；同時自動重試一次
    setActivePlayer(started || !elements["music-audio"].paused ? "music" : null);
    if (started) {
      state.resumeOnVisible = document.hidden;
      setTimeout(() => {
        const retry = elements["music-audio"];
        if (requestId === state.playRequestId && retry.paused && state.currentTrack === index) {
          retry.play().then(() => diag("重試 play() 成功")).catch(e => diag(`重試 play() 失敗 ${e.name}`));
        }
      }, 1500);
    }
    renderPlaylist();
    showToast(error.message || "無法播放這個音樂檔，請確認檔案格式是否受支援。");
  });
}

function releaseTrackSource(index) {
  const track = state.playlist[index];
  if (!track?.sourceUrl) return;
  URL.revokeObjectURL(track.sourceUrl);
  state.objectUrls = state.objectUrls.filter(url => url !== track.sourceUrl);
  track.sourceUrl = null;
}

function releaseDecodedTracks(keepIndices = new Set()) {
  state.playlist.forEach((track, index) => {
    if (!track.decodedUrl || keepIndices.has(index)) return;
    URL.revokeObjectURL(track.decodedUrl);
    state.objectUrls = state.objectUrls.filter(url => url !== track.decodedUrl);
    track.decodedUrl = null;
  });
}

function pcmToWav(channelData, sampleRate) {
  const channelCount = channelData.length;
  const frameCount = channelData[0]?.length || 0;
  if (!channelCount || !frameCount || !sampleRate) throw new Error("OPUS 音樂檔沒有可解碼的音訊資料。");
  const dataSize = frameCount * channelCount * 2;
  if (dataSize > 0xffffffff - 36) throw new Error("這個 OPUS 檔案太大，無法在瀏覽器中轉換播放。");
  const writeText = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) header[offset + i] = value.charCodeAt(i);
  };
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);
  const parts = [header];
  const framesPerPart = Math.max(1, Math.floor(1024 * 1024 / (channelCount * 2)));
  for (let startFrame = 0; startFrame < frameCount; startFrame += framesPerPart) {
    const endFrame = Math.min(startFrame + framesPerPart, frameCount);
    const part = new ArrayBuffer((endFrame - startFrame) * channelCount * 2);
    const partView = new DataView(part);
    let offset = 0;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
        partView.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    parts.push(part);
  }
  return new Blob(parts, { type: "audio/wav" });
}

async function isOpusTrack(track) {
  if (/\.opus$/i.test(track.file.name) || /audio\/opus/i.test(track.file.type)) return true;
  if (!/\.ogg$/i.test(track.file.name) && !/audio\/ogg|application\/ogg/i.test(track.file.type)) return false;
  const header = new Uint8Array(await track.file.slice(0, 64 * 1024).arrayBuffer());
  return new TextDecoder().decode(header).includes("OpusHead");
}

async function prepareOpusTrack(track) {
  if (track.decodedUrl) return track.decodedUrl;
  if (!track.decodePromise) {
    track.decodePromise = (async () => {
      state.opusDecoderPromise ||= import("https://esm.sh/@audio/decode-opus@1.3.3?bundle")
        .then(module => module.default)
        .catch(error => {
          state.opusDecoderPromise = null;
          throw error;
        });
      const decodeOpus = await state.opusDecoderPromise;
      const decoded = await decodeOpus(await track.file.arrayBuffer());
      track.duration = decoded.channelData[0].length / decoded.sampleRate;
      track.decodedUrl = URL.createObjectURL(pcmToWav(decoded.channelData, decoded.sampleRate));
      state.objectUrls.push(track.decodedUrl);
      if (track.removed) {
        URL.revokeObjectURL(track.decodedUrl);
        state.objectUrls = state.objectUrls.filter(url => url !== track.decodedUrl);
        track.decodedUrl = null;
        throw new Error("歌曲已從播放清單移除。");
      }
      return track.decodedUrl;
    })().finally(() => {
      track.decodePromise = null;
    });
  }
  return track.decodePromise;
}

async function getTrackPlaybackUrl(track) {
  // 瀏覽器原生支援 Opus 時不必先讀檔判斷，換歌（尤其在背景）少一次非同步檔案讀取
  const nativeOpus = document.createElement("audio").canPlayType('audio/ogg; codecs="opus"');
  if (!nativeOpus && await isOpusTrack(track)) {
    return prepareOpusTrack(track);
  }
  if (!track.sourceUrl) {
    track.sourceUrl = URL.createObjectURL(track.file);
    state.objectUrls.push(track.sourceUrl);
  }
  return track.sourceUrl;
}

function getNextTrackIndex() {
  if (!state.playlist.length || state.currentTrack < 0) return -1;
  if (state.shuffle && state.playlist.length > 1) {
    if (state.shuffleNextTrack !== null && state.shuffleNextTrack !== state.currentTrack) return state.shuffleNextTrack;
    const available = state.playlist.map((_, index) => index).filter(index => index !== state.currentTrack);
    return available[Math.floor(Math.random() * available.length)];
  }
  return (state.currentTrack + 1) % state.playlist.length;
}

function scheduleNextTrackPreload() {
  clearTimeout(state.preloadTimer);
  state.preloadTimer = null;
  if (state.preloadPromise) return;
  const currentIndex = state.currentTrack;
  const nextIndex = getNextTrackIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;
  const nextTrack = state.playlist[nextIndex];
  state.preloadTimer = setTimeout(async () => {
    state.preloadTimer = null;
    const task = (async () => {
      if (document.createElement("audio").canPlayType('audio/ogg; codecs="opus"')) return;
      const targets = [nextIndex];
      if (!state.shuffle && state.playlist.length > 2) targets.push((nextIndex + 1) % state.playlist.length);
      for (const target of targets) {
        const candidate = state.playlist[target];
        if (!candidate || target === currentIndex || candidate.removed) continue;
        if (!await isOpusTrack(candidate)) continue;
        if (state.shuffle) state.shuffleNextTrack = target;
        diag(`預載解碼 #${target}`);
        await prepareOpusTrack(candidate);
        if (state.currentTrack !== currentIndex) return;
        releaseDecodedTracks(decodedKeepSet(currentIndex));
      }
    })();
    state.preloadPromise = task;
    try {
      await task;
    } catch (error) {
      console.warn("預載入下一首 OPUS 歌曲失敗；切歌時會再嘗試解碼：", error);
      diag(`預載解碼失敗 ${error.message}`);
    } finally {
      if (state.preloadPromise === task) state.preloadPromise = null;
      const next = getNextTrackIndex();
      if (state.activePlayer === "music" && !elements["music-audio"].paused && next >= 0 && next !== nextIndex) {
        scheduleNextTrackPreload();
      }
    }
  }, 900);
}

async function resolveTrackUrl(track) {
  try {
    return await getTrackPlaybackUrl(track);
  } catch (error) {
    if (/\.(opus|ogg)$/i.test(track.file.name)) {
      throw new Error(`OPUS 解碼失敗：${error.message}。請確認檔案是 Ogg Opus 格式並保持網路連線。`);
    }
    throw error;
  }
}

function playNext(automatic = false) {
  if (!state.playlist.length) return;
  if (state.loadingTrack) return;
  if (state.currentTrack < 0) {
    playTrack(0, false);
    return;
  }
  const next = getNextTrackIndex();
  if (automatic && (state.playlist.length === 1 || (!state.shuffle && state.currentTrack === state.playlist.length - 1))) {
    stopMusic(true);
    setActivePlayer(null);
    renderPlaylist();
    return;
  }
  if (next >= 0) {
    if (next === state.shuffleNextTrack) state.shuffleNextTrack = null;
    playTrack(next, true);
  }
}

function playPrevious() {
  if (state.loadingTrack) return;
  if (state.currentTrack < 0) {
    if (state.playlist.length) playTrack(0, false);
    return;
  }
  const audio = elements["music-audio"];
  if (state.activePlayer === "music" && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const previous = state.playHistory.pop();
  if (previous !== undefined && state.playlist[previous]) playTrack(previous, false);
  else if (state.playlist.length) playTrack((state.currentTrack - 1 + state.playlist.length) % state.playlist.length, false);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function updateProgress() {
  const audio = elements["music-audio"];
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    elements["current-time"].textContent = "0:00";
    elements["duration-time"].textContent = "0:00";
    elements["seek-bar"].value = "0";
    elements["seek-bar"].disabled = true;
    return;
  }
  elements["current-time"].textContent = formatTime(audio.currentTime);
  elements["duration-time"].textContent = formatTime(duration);
  elements["seek-bar"].value = String(Math.round(audio.currentTime / duration * 1000));
  elements["seek-bar"].disabled = false;
  updateMediaPosition();
}

function renderPlaylist() {
  elements["previous-button"].disabled = state.loadingTrack || !state.playlist.length;
  elements["next-button"].disabled = state.loadingTrack || !state.playlist.length;
  elements["playlist-count"].textContent = `${state.playlist.length} 首歌曲`;
  elements["playlist-subtitle"].textContent = state.directoryLoaded ? "已從資料夾加入音樂" : "本地播放清單";
  if (!state.playlist.length) {
    elements["track-list"].innerHTML = `<div class="music-empty"><span aria-hidden="true">♫</span><strong>你的音樂，還在路上</strong><p>從裝置選取音樂檔案，或一次匯入整個資料夾。</p></div>`;
    elements["playlist-count"].textContent = "尚未加入音樂";
    elements["playlist-subtitle"].textContent = savedLibraryHint() || "選取音樂檔案開始播放";
    return;
  }
  const scrollTop = elements["track-list"].scrollTop;
  const maxStart = Math.max(0, state.playlist.length - TRACK_WINDOW_SIZE);
  state.playlistStart = Math.max(0, Math.min(maxStart, Math.floor(scrollTop / TRACK_ROW_HEIGHT) - 8));
  const end = Math.min(state.playlist.length, state.playlistStart + TRACK_WINDOW_SIZE);
  const rows = state.playlist.slice(state.playlistStart, end).map((track, relativeIndex) => {
    const index = state.playlistStart + relativeIndex;
    const playing = index === state.currentTrack;
    return `<div class="track-row${playing ? " is-playing" : ""}">
      <div class="track-title-cell">
        <span class="track-index">${playing ? "♫" : String(index + 1).padStart(2, "0")}</span>
        <button class="track-play-small" type="button" data-play-track="${index}" aria-label="播放 ${escapeHtml(track.title)}" ${state.loadingTrack ? "disabled" : ""}>${playing && state.activePlayer === "music" ? "Ⅱ" : "▶"}</button>
        <span class="track-title-text"><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist || "本地音樂")}</small></span>
      </div>
      <span class="track-file" title="${escapeHtml(track.file.name)}">${escapeHtml(track.file.name)}</span>
      <span class="track-duration">${track.duration ? formatTime(track.duration) : "—:—"}</span>
      <button class="remove-track" type="button" data-remove-track="${index}" aria-label="移除 ${escapeHtml(track.title)}">×</button>
    </div>`;
  }).join("");
  elements["track-list"].innerHTML = `<div class="track-virtual-spacer" aria-hidden="true" style="height:${state.playlistStart * TRACK_ROW_HEIGHT}px"></div>${rows}<div class="track-virtual-spacer" aria-hidden="true" style="height:${(state.playlist.length - end) * TRACK_ROW_HEIGHT}px"></div>`;
  elements["track-list"].scrollTop = scrollTop;
  elements["track-list"].querySelectorAll("[data-play-track]").forEach(button => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.playTrack);
      if (state.currentTrack === index && state.activePlayer === "music") togglePlayback();
      else playTrack(index);
    });
  });
  elements["track-list"].querySelectorAll("[data-remove-track]").forEach(button => {
    button.addEventListener("click", () => removeTrack(Number(button.dataset.removeTrack)));
  });
}

function addFiles(fileList, fromDirectory) {
  const audioFiles = Array.from(fileList).filter(file => file.type.startsWith("audio/") ||
    /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|aiff|wma|webm)$/i.test(file.name));
  if (!audioFiles.length) {
    showToast("沒有找到可播放的音樂檔案。");
    return;
  }
  const fileKey = file => `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
  const existing = new Set(state.playlist.map(track => fileKey(track.file)));
  const freshFiles = audioFiles.filter(file => {
    const key = fileKey(file);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  if (!freshFiles.length) {
    showToast("這些音樂已經在播放清單中了。");
    return;
  }
  if (fromDirectory) freshFiles.sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath, "zh-TW"));
  state.playlist.push(...freshFiles.map(file => ({
    file,
    title: file.name.replace(/\.[^.]+$/, ""),
    artist: "",
    duration: 0,
    sourceUrl: null,
    decodedUrl: null,
    decodePromise: null
  })));
  state.directoryLoaded = state.directoryLoaded || fromDirectory;
  renderPlaylist();
  if (state.activePlayer === "music") scheduleNextTrackPreload();
  if (!restoreLastSession()) {
    saveLibrary();
    showToast(`已加入 ${freshFiles.length} 首歌曲。`);
  }
}

function removeTrack(index) {
  const removed = state.playlist[index];
  if (!removed) return;
  removed.removed = true;
  if (index === state.currentTrack) {
    stopMusic(true);
    elements["music-audio"].removeAttribute("src");
    elements["music-audio"].load();
    state.activePlayer = null;
    state.currentTrack = -1;
    updateNowPlaying("準備好開始收聽了嗎？", "選一個電台，或播放你的音樂");
    setActivePlayer(null);
  } else if (index < state.currentTrack) {
    state.currentTrack -= 1;
  }
  state.playHistory = state.playHistory.filter(historyIndex => historyIndex !== index)
    .map(historyIndex => historyIndex > index ? historyIndex - 1 : historyIndex);
  releaseTrackSource(index);
  if (removed.decodedUrl) {
    URL.revokeObjectURL(removed.decodedUrl);
    state.objectUrls = state.objectUrls.filter(url => url !== removed.decodedUrl);
  }
  state.playlist.splice(index, 1);
  if (state.shuffleNextTrack === index) state.shuffleNextTrack = null;
  else if (state.shuffleNextTrack !== null && state.shuffleNextTrack > index) state.shuffleNextTrack -= 1;
  renderPlaylist();
  if (state.activePlayer === "music") scheduleNextTrackPreload();
}

function togglePlayback() {
  if (state.activeStation?.externalPlayer) {
    showToast("請使用 KISS 官方播放器中的控制項播放或調整音量。");
    return;
  }
  if (state.loadingTrack) {
    showToast("音樂仍在準備中，請稍候再操作。");
    return;
  }
  const player = state.activePlayer;
  const audio = player === "radio" ? elements["radio-audio"] : player === "music" ? elements["music-audio"] : null;
  if (audio) {
    if (audio.paused) {
      if (player === "music" && state.audioContext?.state === "suspended") state.audioContext.resume().catch(error => console.error("無法啟用音訊播放：", error));
      audio.play().then(() => setActivePlayer(player)).catch(error => {
        console.error("播放失敗：", error);
        showToast("播放失敗，請確認電台串流或音樂檔案是否可用。");
      });
    } else {
      audio.pause();
      setActivePlayer(player);
      if (player === "music") renderPlaylist();
    }
  } else if (state.activeStation) {
    playStation(state.activeStation);
  } else if (state.currentTrack >= 0) {
    playTrack(state.currentTrack, false);
  } else if (state.playlist.length) {
    playTrack(0, false);
  } else {
    showToast("先選一個電台，或從裝置加入音樂檔案。");
  }
}

function showToast(message) {
  elements["toast"].textContent = message;
  elements["toast"].classList.add("show");
  clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(() => elements["toast"].classList.remove("show"), 3200);
}

function switchView(view) {
  const music = view === "music";
  elements["radio-view"].hidden = music;
  elements["music-view"].hidden = !music;
  elements["view-breadcrumb"].textContent = music ? "我的音樂" : "網路廣播";
  document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (!music) window.scrollTo({ top: 0, behavior: "smooth" });
}

function setCategory(category) {
  state.category = category;
  state.visibleCount = PAGE_SIZE;
  document.querySelectorAll("[data-category]").forEach(button => button.classList.toggle("active", button.dataset.category === category));
  renderStations();
}

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", () => setCategory(button.dataset.category)));
elements["station-search"].addEventListener("input", event => {
  state.query = event.target.value;
  state.visibleCount = PAGE_SIZE;
  renderStations();
});
elements["city-filter"].addEventListener("change", event => {
  state.city = event.target.value;
  state.visibleCount = PAGE_SIZE;
  renderStations();
});
elements["station-sort"].addEventListener("change", event => {
  state.sort = event.target.value;
  state.visibleCount = PAGE_SIZE;
  renderStations();
});
elements["load-more"].addEventListener("click", () => {
  state.visibleCount += PAGE_SIZE;
  renderStations();
});
elements["pick-files"].addEventListener("click", () => elements["file-input"].click());
elements["pick-folder"].addEventListener("click", () => elements["folder-input"].click());
elements["file-input"].addEventListener("change", event => {
  addFiles(event.target.files, false);
  event.target.value = "";
});
elements["folder-input"].addEventListener("change", event => {
  addFiles(event.target.files, true);
  event.target.value = "";
});
elements["shuffle-button"].addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  state.shuffleNextTrack = null;
  elements["shuffle-button"].classList.toggle("active", state.shuffle);
  elements["shuffle-button"].setAttribute("aria-pressed", String(state.shuffle));
  saveLibrary();
  if (state.activePlayer === "music") scheduleNextTrackPreload();
});
elements["balance-button"].addEventListener("click", () => {
  state.balance = !state.balance;
  elements["balance-button"].classList.toggle("active", state.balance);
  elements["balance-button"].setAttribute("aria-pressed", String(state.balance));
  if (state.balance) initializeAudioProcessing();
  setTrackGainNormalization(state.balance && state.activePlayer === "music");
});
elements["previous-button"].addEventListener("click", playPrevious);
elements["next-button"].addEventListener("click", () => playNext());
elements["play-button"].addEventListener("click", togglePlayback);
elements["stop-button"].addEventListener("click", stopAll);
elements["seek-bar"].addEventListener("input", event => {
  const audio = elements["music-audio"];
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
});
elements["volume-control"].addEventListener("input", event => {
  const volume = Number(event.target.value);
  elements["radio-audio"].volume = volume;
  elements["music-audio"].volume = volume;
  if (state.standby) state.standby.volume = volume;
  elements["volume-value"].textContent = `${Math.round(volume * 100)}%`;
});
const standbyAudio = document.createElement("audio");
standbyAudio.preload = "auto";
standbyAudio.hidden = true;
document.body.appendChild(standbyAudio);
state.standby = standbyAudio;
state.standbyIndex = -1;
state.handingOff = false;

// 兩個 <audio> 輪流當主播放器；事件只處理「目前的主播放器」
function bindMusicAudio(audio) {
  const active = fn => (...args) => { if (audio === elements["music-audio"]) fn(...args); };
  audio.addEventListener("timeupdate", active(() => { updateProgress(); maybeHandoff(); }));
  audio.addEventListener("durationchange", active(() => updateProgress()));
  audio.addEventListener("loadedmetadata", active(() => {
    updateProgress();
    const track = state.playlist[state.currentTrack];
    if (track && Number.isFinite(audio.duration)) {
      track.duration = audio.duration;
      renderPlaylist();
    }
  }));
  audio.addEventListener("play", active(() => {
    state.activePlayer = "music";
    setActivePlayer("music");
    startTrackGainNormalization();
  }));
  audio.addEventListener("pause", active(() => {
    stopTrackGainNormalization();
    if (state.activePlayer === "music") setActivePlayer("music");
    renderPlaylist();
  }));
  audio.addEventListener("ended", active(() => {
    if (!state.loadingTrack && !state.handingOff) playNext(true);
  }));
  ["play", "pause", "ended", "error", "stalled", "waiting", "emptied", "abort"].forEach(name => {
    audio.addEventListener(name, () => {
      const code = name === "error" && audio.error ? ` code=${audio.error.code}` : "";
      const tag = audio === elements["music-audio"] ? "" : "(備用)";
      diag(`audio${tag} ${name} #${state.currentTrack} t=${Math.round(audio.currentTime)} ${document.visibilityState}${code}`);
    });
  });
}
bindMusicAudio(elements["music-audio"]);
bindMusicAudio(standbyAudio);
document.addEventListener("visibilitychange", () => {
  diag(`頁面 ${document.visibilityState}`);
  if (document.hidden) { saveLibrary(); return; }
  if (!state.resumeOnVisible) return;
  state.resumeOnVisible = false;
  const audio = elements["music-audio"];
  if (audio.paused && state.currentTrack >= 0 && state.activePlayer === "music") audio.play().catch(() => {});
});
elements["radio-audio"].addEventListener("play", () => setActivePlayer("radio"));
elements["radio-audio"].addEventListener("pause", () => {
  if (state.activePlayer === "radio") setActivePlayer("radio");
});
elements["radio-audio"].addEventListener("error", () => {
  if (state.activeStation && elements["radio-audio"].src) {
    showToast("電台串流連線中斷，請選擇其他電台或稍後重試。");
  }
});
elements["close-official-player"].addEventListener("click", () => elements["official-player-dialog"].close());
document.querySelectorAll("[data-kiss-channel]").forEach(button => button.addEventListener("click", () => {
  state.kissChannel = button.dataset.kissChannel;
  setKissChannel(state.kissChannel);
}));
elements["track-list"].addEventListener("scroll", () => {
  if (!state.playlist.length) return;
  const start = Math.max(0, Math.min(
    Math.max(0, state.playlist.length - TRACK_WINDOW_SIZE),
    Math.floor(elements["track-list"].scrollTop / TRACK_ROW_HEIGHT) - 8
  ));
  if (start !== state.playlistStart) renderPlaylist();
}, { passive: true });
elements["official-player-dialog"].addEventListener("close", () => {
  elements["official-player-frame"].src = "about:blank";
  if (state.externalPlayerOpen) {
    state.externalPlayerOpen = false;
    state.activeStation = null;
    state.activePlayer = null;
    updateNowPlaying("準備好開始收聽了嗎？", "選一個電台，或播放你的音樂");
    renderStations();
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    switchView("radio");
    elements["station-search"].focus();
  } else if (event.code === "Space" && !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    togglePlayback();
  }
});
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  state.installPrompt = event;
  elements["install-button"].hidden = false;
});
elements["install-button"].addEventListener("click", async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  elements["install-button"].hidden = true;
});
window.addEventListener("pagehide", event => {
  saveLibrary();
  if (event.persisted) return; // 只是進入背景快取，不要把還在用的音檔網址作廢
  stopTrackGainNormalization();
  state.objectUrls.forEach(url => URL.revokeObjectURL(url));
});

diag(`啟動 ${navigator.userAgent.match(/(SamsungBrowser|Chrome|Version)\/[\d.]+/)?.[0] || "?"} nativeOpus=${document.createElement("audio").canPlayType('audio/ogg; codecs="opus"') || "無"}`);
{
  const panel = document.getElementById("diag-panel");
  const box = document.getElementById("diag-log");
  const render = () => { if (box) box.textContent = diagLines.join("\n") || "（目前沒有記錄）"; };
  panel?.addEventListener("toggle", render);
  document.getElementById("diag-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diagLines.join("\n"));
      showToast("已複製記錄。");
    } catch {
      render();
      showToast("無法自動複製，請長按記錄文字手動複製。");
    }
  });
  document.getElementById("diag-clear")?.addEventListener("click", () => {
    diagLines = [];
    try { localStorage.removeItem(DIAG_KEY); } catch { /* ignore */ }
    render();
  });
}
if (!state.playlist.length) renderPlaylist();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(error => {
    console.error("無法註冊離線快取：", error);
    showToast("離線快取安裝失敗；網頁仍可正常使用。");
  }));
}

loadStations();
