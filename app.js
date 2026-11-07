const API_BASE = "https://de1.api.radio-browser.info/json";
const CATALOG_LIMIT = 1000;
const PAGE_SIZE = 12;
const TRACK_ROW_HEIGHT = 57;
const TRACK_WINDOW_SIZE = 60;
const FAVORITES_KEY = "island-fm-favorite-stations";
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
const TAICHUNG_GOODFM_STATION = {
  stationuuid: "goodfm-taichung-fm903",
  name: "好事聯播網 台中好事",
  url_resolved: "http://202.39.43.67:1935/live/RA000010/chunklist.m3u8",
  homepage: "http://www.bestradio.com.tw/",
  country: "Taiwan, Republic Of China",
  state: "台中",
  tags: "台中,好事聯播網",
  frequency: 90.3,
  clickcount: 0,
  votes: 0
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
  "official-player-frame", "close-official-player", "official-player-hint",
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
  balance: true,
  audioContext: null,
  objectUrls: [],
  playHistory: [],
  toastTimeout: null,
  installPrompt: null,
  directoryLoaded: false,
  kissChannel: "twitch"
};

function stationId(station) {
  return station.stationuuid || `${station.name}|${station.url_resolved}`;
}

function getStationCity(station) {
  const search = `${station.name || ""} ${station.tags || ""} ${station.state || ""} ${station.homepage || ""}`.replace(/臺/g, "台").toLowerCase();
  return cities.find(city => search.includes(city.toLowerCase())) || "";
}

function getStationFrequency(station) {
  const declaredFrequency = Number(station.frequency);
  if (Number.isFinite(declaredFrequency) && declaredFrequency >= 76 && declaredFrequency <= 108) {
    return declaredFrequency.toFixed(1);
  }
  const match = `${station.name || ""} ${station.tags || ""}`.match(/(?:\bFM\s*|)(\d{2,3}\.\d{1,2})(?=\s*(?:MHz|FM)?(?:\b|$))/i);
  const frequency = Number(match?.[1]);
  return Number.isFinite(frequency) && frequency >= 76 && frequency <= 108
    ? frequency.toFixed(1)
    : "";
}

function getStationDisplayName(station) {
  const frequency = getStationFrequency(station);
  if (!frequency || (station.name || "").includes(frequency)) {
    return station.name;
  }
  return `${station.name} · FM ${frequency}`;
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
    const text = `${getStationDisplayName(station)} ${station.name} ${station.tags} ${station.homepage}`.toLocaleLowerCase();
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
    const popularity = station.externalPlayer ? "官方直播" : `${Number(station.clickcount) || 0} 次收聽`;
    return `<article class="station-card${playing ? " is-playing" : ""}">
      <div class="station-logo" data-tone="${index % 4}">${escapeHtml(initials(station.name))}</div>
      <div class="station-info">
        <strong class="station-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</strong>
        <span class="station-meta" title="${station.externalPlayer ? "KISS RADIO 官方直播" : `Radio Browser 目錄點擊次數：${Number(station.clickcount) || 0}`}">${escapeHtml(category === "police" ? "警察廣播電台" : meta)} · ${escapeHtml(popularity)}</span>
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
    const hasGoodFM903 = [...deduplicated.values()].some(station =>
      getStationFrequency(station) === "90.3" && /好事/.test(`${station.name} ${station.tags}`)
    );
    if (!hasGoodFM903) deduplicated.set(stationId(TAICHUNG_GOODFM_STATION), TAICHUNG_GOODFM_STATION);
    deduplicated.set(stationId(KISS_STATION), KISS_STATION);
    if (!deduplicated.size) throw new Error("電台目錄目前沒有提供可播放的台灣電台。");
    state.stations = [...deduplicated.values()];
    updateCityFilter();
    renderStations();
    elements["connection-text"].textContent = "電台目錄已連線";
    elements["catalog-message"].hidden = true;
  } catch (error) {
    console.error("載入電台目錄失敗：", error);
    elements["connection-text"].textContent = "目錄連線失敗";
    elements["catalog-message"].innerHTML = `暫時無法載入電台目錄：${escapeHtml(error.message)} <button type="button" id="retry-catalog">重試</button>`;
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
}

function updateNowPlaying(title, subtitle, music = false) {
  elements["now-title"].textContent = title;
  elements["now-subtitle"].textContent = subtitle;
  elements["cover-art"].classList.toggle("is-music", music);
}

async function playStation(station) {
  if (station.externalPlayer) {
    stopRadio();
    stopMusic(false);
    state.activeStation = station;
    state.activePlayer = null;
    updateNowPlaying(getStationDisplayName(station), "高雄 FM99.9 · 官方直播播放器");
    renderStations();
    setKissChannel(state.kissChannel);
    elements["official-player-dialog"].showModal();
    return;
  }
  stopMusic(false);
  const audio = elements["radio-audio"];
  state.activeStation = station;
  audio.src = station.url_resolved;
  audio.volume = Number(elements["volume-control"].value);
  updateNowPlaying(getStationDisplayName(station), "台灣網路廣播 · 直播中");
  setActivePlayer("radio");
  renderStations();
  try {
    await audio.play();
    setActivePlayer("radio");
  } catch (error) {
    console.error("無法播放電台：", error);
    setActivePlayer(null);
    state.activeStation = null;
    renderStations();
    updateNowPlaying("無法播放這個電台", "請稍後再試，或選擇其他電台");
    showToast("電台播放失敗，可能是串流暫時離線或瀏覽器不支援此格式。");
  }
}

function setKissChannel(channel) {
  const isTwitch = channel === "twitch";
  const twitchParent = location.hostname || "localhost";
  const pageUrl = isTwitch
    ? `https://player.twitch.tv/?channel=livekiss&parent=${encodeURIComponent(twitchParent)}&autoplay=true`
    : `https://www.kiss.com.tw/radio_hq.php?fm=999&player=${channel}`;
  const channelName = channel === "lh" ? "官方頻道一" : channel === "youtube" ? "官方頻道二" : "Twitch 直播";
  elements["official-player-frame"].src = pageUrl;
  elements["official-player-hint"].textContent = isTwitch
    ? "使用 Twitch LiveKiss 直播；請在播放器中啟動播放並調整音量。"
    : `使用 KISS RADIO ${channelName}；若播放器未載入，可改用新分頁開啟。`;
  elements["official-player-link"].href = isTwitch
    ? "https://www.twitch.tv/livekiss"
    : pageUrl;
  elements["official-player-link"].innerHTML = `在新分頁開啟 ${isTwitch ? "Twitch LiveKiss" : `KISS RADIO ${channelName}`} <span aria-hidden="true">↗</span>`;
  document.querySelectorAll("[data-kiss-channel]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.kissChannel === channel));
  });
}

function stopRadio() {
  const audio = elements["radio-audio"];
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.activeStation = null;
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
  stopRadio();
  const track = state.playlist[index];
  const audio = elements["music-audio"];
  initializeAudioProcessing();
  if (state.audioContext && state.audioContext.state === "suspended") state.audioContext.resume().catch(error => {
    console.error("無法啟用音訊播放：", error);
  });
  const alreadyPrepared = Boolean(track.decodedUrl || track.sourceUrl);
  if (previousIndex < 0 && !alreadyPrepared) showToast("正在準備音樂…");
  resolveTrackUrl(track).then(url => {
    if (requestId !== state.playRequestId) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (previousIndex !== index) releaseTrackSource(previousIndex);
    if (remember && previousIndex >= 0 && previousIndex !== index) state.playHistory.push(previousIndex);
    state.currentTrack = index;
    state.shuffleNextTrack = null;
    const nextIndex = state.shuffle ? -1 : (index + 1) % state.playlist.length;
    releaseDecodedTracks(new Set([index, nextIndex]));
    state.loadingTrack = false;
    elements["previous-button"].disabled = false;
    elements["next-button"].disabled = false;
    audio.src = url;
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
    return audio.play();
  }).then(() => {
    if (requestId === state.playRequestId) {
      setActivePlayer("music");
      startTrackGainNormalization();
      scheduleNextTrackPreload();
    }
  }).catch(error => {
    if (requestId !== state.playRequestId) return;
    console.error("無法播放本地音樂：", error);
    state.loadingTrack = false;
    elements["previous-button"].disabled = false;
    elements["next-button"].disabled = false;
    setActivePlayer(elements["music-audio"].paused ? null : "music");
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
  const isOpus = await isOpusTrack(track);
  if (isOpus && !document.createElement("audio").canPlayType('audio/ogg; codecs="opus"')) {
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
      if (!await isOpusTrack(nextTrack) ||
          document.createElement("audio").canPlayType('audio/ogg; codecs="opus"')) return;
      if (state.shuffle) state.shuffleNextTrack = nextIndex;
      await prepareOpusTrack(nextTrack);
      if (state.currentTrack !== currentIndex) return;
      const keep = new Set([state.currentTrack, getNextTrackIndex()]);
      releaseDecodedTracks(keep);
    })();
    state.preloadPromise = task;
    try {
      await task;
    } catch (error) {
      console.warn("預載入下一首 OPUS 歌曲失敗；切歌時會再嘗試解碼：", error);
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
}

function renderPlaylist() {
  elements["previous-button"].disabled = state.loadingTrack || !state.playlist.length;
  elements["next-button"].disabled = state.loadingTrack || !state.playlist.length;
  elements["playlist-count"].textContent = `${state.playlist.length} 首歌曲`;
  elements["playlist-subtitle"].textContent = state.directoryLoaded ? "已從資料夾加入音樂" : "本地播放清單";
  if (!state.playlist.length) {
    elements["track-list"].innerHTML = `<div class="music-empty"><span aria-hidden="true">♫</span><strong>你的音樂，還在路上</strong><p>從裝置選取音樂檔案，或一次匯入整個資料夾。</p></div>`;
    elements["playlist-count"].textContent = "尚未加入音樂";
    elements["playlist-subtitle"].textContent = "選取音樂檔案開始播放";
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
  showToast(`已加入 ${freshFiles.length} 首歌曲。`);
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
  if (state.activePlayer === "music") scheduleNextTrackPreload();
});
elements["balance-button"].addEventListener("click", () => {
  state.balance = !state.balance;
  elements["balance-button"].classList.toggle("active", state.balance);
  elements["balance-button"].setAttribute("aria-pressed", String(state.balance));
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
  elements["volume-value"].textContent = `${Math.round(volume * 100)}%`;
});
elements["music-audio"].addEventListener("timeupdate", updateProgress);
elements["music-audio"].addEventListener("durationchange", updateProgress);
elements["music-audio"].addEventListener("loadedmetadata", () => {
  updateProgress();
  const track = state.playlist[state.currentTrack];
  if (track && Number.isFinite(elements["music-audio"].duration)) {
    track.duration = elements["music-audio"].duration;
    renderPlaylist();
  }
});
elements["music-audio"].addEventListener("play", () => {
  state.activePlayer = "music";
  setActivePlayer("music");
  startTrackGainNormalization();
});
elements["music-audio"].addEventListener("pause", () => {
  stopTrackGainNormalization();
  if (state.activePlayer === "music") setActivePlayer("music");
  renderPlaylist();
});
elements["music-audio"].addEventListener("ended", () => {
  if (!state.loadingTrack) playNext(true);
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
  if (state.activeStation?.externalPlayer) {
    state.activeStation = null;
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
window.addEventListener("pagehide", () => {
  stopTrackGainNormalization();
  state.objectUrls.forEach(url => URL.revokeObjectURL(url));
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(error => {
    console.error("無法註冊離線快取：", error);
    showToast("離線快取安裝失敗；網頁仍可正常使用。");
  }));
}

loadStations();
