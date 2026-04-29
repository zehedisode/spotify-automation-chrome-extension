import {
  SPOTIFY_HOME_URL,
  ensureSpotifyTab,
  findSpotifyTab,
  getSpotifyStatus,
  isSpotifyUrl,
  normalizeSpotifyPlaylistUrl,
  openSpotifyUrl,
  pauseSpotify,
  previousSpotifyTrack,
  resumeSpotify,
  setSpotifyMaxVolume,
  setSpotifyVolume,
  skipSpotifyTrack,
  startSpotifyPlayback,
} from './spotifyController.js';

const LOG_PREFIX = '[Spotify Video Sync]';
const RUNTIME_STATE_KEY = 'spotifyVideoSyncRuntime';
const VIDEO_STATE_KEY = 'spotifyVideoSyncVideoFrames';
const RECONCILE_ALARM = 'spotify-video-sync-reconcile';
const RESUME_GRACE_MS = 900;
const VIDEO_STATE_TTL_MS = 15000;

const DEFAULT_SETTINGS = Object.freeze({
  playlistUrl: '',
  maxVolume: 50,
  pauseSpotifyOnVideo: true,
  autoOpenSpotify: true,
});

const videoFrames = new Map();

let currentSettings = { ...DEFAULT_SETTINGS };
let pausedByExtension = false;
let spotifyTabId = null;
let operationQueue = Promise.resolve();

const readyPromise = initializeState().catch((error) => {
  console.warn(LOG_PREFIX, 'Initial state could not be loaded; defaults will be used.', error);
});

chrome.runtime.onInstalled.addListener(() => {
  enqueueTask('installed', async () => {
    currentSettings = await loadSettings({ seed: true });
    await runOpenSpotifyAutomation('installed');
  });
});

chrome.runtime.onStartup.addListener(() => {
  enqueueTask('startup', async () => {
    currentSettings = await loadSettings({ seed: true });
    await runOpenSpotifyAutomation('startup');
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueueTask(`message:${message && message.type}`, () => handleMessage(message, sender))
    .then((response) => {
      sendResponse(response || { ok: true });
    })
    .catch((error) => {
      console.warn(LOG_PREFIX, 'Message handling failed.', error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTask('tab-removed', async () => {
    const hadVideo = removeVideoStatesForTab(tabId);
    if (hadVideo) {
      await persistVideoFrames();
    }

    if (tabId === spotifyTabId) {
      spotifyTabId = null;
      await setPausedByExtension(false);
      console.info(LOG_PREFIX, 'Spotify tab was closed.');
    }

    if (hadVideo) {
      await syncSpotifyWithVideoState('tab-removed');
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || !tab.url || !isSpotifyUrl(tab.url)) {
    return;
  }

  enqueueTask('tab-updated', async () => {
    spotifyTabId = tabId;
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || (tab && tab.url && isSpotifyUrl(tab.url))) {
    return;
  }

  enqueueTask('tab-loading', async () => {
    if (changeInfo.status === 'loading') {
      const hadVideo = removeVideoStatesForTab(tabId);
      if (hadVideo) {
        await persistVideoFrames();
        await syncSpotifyWithVideoState('tab-loading');
      }
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  enqueueTask('settings-changed', async () => {
    currentSettings = await loadSettings({ seed: false });
    await runOpenSpotifyAutomation('settings-changed');
    await syncSpotifyWithVideoState('settings-changed');
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONCILE_ALARM) {
    return;
  }

  enqueueTask('alarm-reconcile', async () => {
    currentSettings = await loadSettings({ seed: false });
    if (pruneStaleVideoFrames()) {
      await persistVideoFrames();
    }
    await syncSpotifyWithVideoState('alarm-reconcile');
  });
});

async function initializeState() {
  currentSettings = await loadSettings({ seed: true });

  const runtime = await storageGet('local', RUNTIME_STATE_KEY);
  pausedByExtension = Boolean(runtime[RUNTIME_STATE_KEY]?.pausedByExtension);
  await restoreVideoFrames();
  if (pruneStaleVideoFrames()) {
    await persistVideoFrames();
  }

  chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 1 });
  console.info(LOG_PREFIX, 'Service worker ready.');
}

function enqueueTask(label, task) {
  const nextTask = operationQueue
    .catch(() => {})
    .then(() => readyPromise)
    .then(task);

  operationQueue = nextTask.catch((error) => {
    console.warn(LOG_PREFIX, `${label} failed.`, error);
  });

  return nextTask;
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: 'Unknown message.' };
  }

  if (message.type === 'VIDEO_STATE_CHANGED') {
    const changed = updateVideoState(message, sender);
    await persistVideoFrames();
    if (changed) {
      await syncSpotifyWithVideoState(`video:${message.reason || 'change'}`);
    }

    const anyPlaying = isAnyVideoPlaying();
    const tabId = sender?.tab?.id;
    if (Number.isInteger(tabId)) {
      try {
        chrome.tabs.sendMessage(tabId, {
          type: 'BAR_VIDEO_STATE',
          isPlaying: anyPlaying,
          title: message.title || sender?.tab?.title || '',
        });
      } catch (e) {
        // Tab may not have the bar content script
      }
    }

    return {
      ok: true,
      anyVideoPlaying: anyPlaying,
      trackedVideoFrames: videoFrames.size,
    };
  }

  if (message.type === 'SETTINGS_UPDATED') {
    currentSettings = normalizeSettings({ settings: message.settings || {} });
    await runOpenSpotifyAutomation('settings-updated-message');
    await syncSpotifyWithVideoState('settings-updated-message');
    return { ok: true, settings: currentSettings };
  }

  if (message.type === 'GET_SETTINGS') {
    return { ok: true, settings: currentSettings };
  }

  if (message.type === 'SPOTIFY_COMMAND') {
    return handleSpotifyCommand(message);
  }

  if (message.type === 'GET_SPOTIFY_STATUS') {
    return getPopupSpotifyStatus();
  }

  return { ok: false, error: `Unsupported message type: ${message.type}` };
}

function updateVideoState(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    return false;
  }

  if (sender.tab?.url && isSpotifyUrl(sender.tab.url)) {
    return false;
  }

  const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
  const key = `${tabId}:${frameId}`;
  const wasPlaying = videoFrames.has(key);

  if (message.isPlaying) {
    videoFrames.set(key, {
      tabId,
      frameId,
      title: message.title || sender.tab?.title || '',
      url: message.url || sender.tab?.url || '',
      reason: message.reason || '',
      activeVideoCount: message.activeVideoCount || 1,
      updatedAt: Date.now(),
    });

    if (!wasPlaying) {
      console.info(LOG_PREFIX, 'Video detected.', videoFrames.get(key));
    }

    return !wasPlaying;
  }

  if (wasPlaying) {
    videoFrames.delete(key);
    console.info(LOG_PREFIX, 'Video stopped.', { tabId, frameId, reason: message.reason });
    return true;
  }

  return false;
}

async function syncSpotifyWithVideoState(reason) {
  if (pruneStaleVideoFrames()) {
    await persistVideoFrames();
  }

  if (!currentSettings.pauseSpotifyOnVideo) {
    if (pausedByExtension) {
      await resumeSpotifyIfNeeded(`${reason}:feature-disabled`, { ignoreVideos: true });
    }
    return;
  }

  if (isAnyVideoPlaying()) {
    await pauseSpotifyForVideo(reason);
    return;
  }

  await resumeSpotifyIfNeeded(reason);
}

async function pauseSpotifyForVideo(reason) {
  if (pausedByExtension) {
    return;
  }

  const tab = await findSpotifyTab();
  if (!tab) {
    console.info(LOG_PREFIX, 'Video is playing, but no Spotify tab exists.');
    return;
  }

  spotifyTabId = tab.id;

  const status = await getSpotifyStatus(tab.id);
  if (!status.isPlaying) {
    console.info(LOG_PREFIX, 'Spotify is already paused; automatic resume is disabled for this video.');
    return;
  }

  await pauseSpotify(tab.id);
  await setPausedByExtension(true);
  console.info(LOG_PREFIX, 'Spotify paused because a video started.', { reason });
}

async function resumeSpotifyIfNeeded(reason, options = {}) {
  const { ignoreVideos = false } = options;

  if (!pausedByExtension) {
    return;
  }

  await delay(RESUME_GRACE_MS);

  if (!ignoreVideos && isAnyVideoPlaying()) {
    return;
  }

  const tab = await findSpotifyTab();
  if (!tab) {
    await setPausedByExtension(false);
    console.info(LOG_PREFIX, 'Spotify tab is gone; automatic resume cancelled.');
    return;
  }

  spotifyTabId = tab.id;
  await setSpotifyMaxVolume(tab.id, currentSettings.maxVolume);
  await resumeSpotify(tab.id);
  await setPausedByExtension(false);

  console.info(LOG_PREFIX, 'Spotify resumed after videos stopped.', { reason });
}

async function runOpenSpotifyAutomation(reason) {
  if (!currentSettings.autoOpenSpotify) {
    return;
  }

  const tab = await ensureSpotifyTab({
    create: true,
    preferredUrl: currentSettings.playlistUrl || SPOTIFY_HOME_URL,
    active: false,
  });

  if (!tab) {
    return;
  }

  spotifyTabId = tab.id;
  console.info(LOG_PREFIX, 'Spotify tab is ready; auto playback is removed.', { reason });
}

async function handleSpotifyCommand(message) {
  const command = String(message.command || '');

  if (command === 'open') {
    const tab = await ensureSpotifyTab({
      create: true,
      preferredUrl: currentSettings.playlistUrl || SPOTIFY_HOME_URL,
      active: true,
    });

    spotifyTabId = tab?.id || spotifyTabId;
    return getPopupSpotifyStatus();
  }

  const tab = await ensureSpotifyTab({
    create: command === 'playPause' || command === 'applyPlaylist',
    preferredUrl: currentSettings.playlistUrl || SPOTIFY_HOME_URL,
    active: false,
  });

  if (!tab) {
    return {
      ok: false,
      error: 'Spotify sekmesi bulunamadı.',
      hasSpotifyTab: false,
    };
  }

  spotifyTabId = tab.id;

  if (command === 'playPause') {
    const status = await getSpotifyStatus(tab.id);
    if (status.isPlaying) {
      await pauseSpotify(tab.id);
    } else {
      if (currentSettings.playlistUrl) {
        await openSpotifyUrl(tab.id, currentSettings.playlistUrl);
        await delay(700);
      }

      await startSpotifyPlayback(tab.id, {
        attempts: 2,
        delayMs: 800,
        preferContextPlay: Boolean(currentSettings.playlistUrl),
        readyTimeoutMs: 12000,
      });
    }
  } else if (command === 'pause') {
    await pauseSpotify(tab.id);
  } else if (command === 'next') {
    await skipSpotifyTrack(tab.id);
  } else if (command === 'previous') {
    await previousSpotifyTrack(tab.id);
  } else if (command === 'setVolume') {
    const volume = sanitizeVolume(message.volume);
    currentSettings = {
      ...currentSettings,
      maxVolume: volume,
    };
    await storageSet('sync', toStoragePayload(currentSettings));
    await setSpotifyVolume(tab.id, volume);
  } else if (command === 'applyPlaylist') {
    if (currentSettings.playlistUrl) {
      await openSpotifyUrl(tab.id, currentSettings.playlistUrl);
    } else {
      return {
        ok: false,
        error: 'Önce bir Spotify playlist URL’si kaydet.',
      };
    }
  } else {
    return {
      ok: false,
      error: `Bilinmeyen Spotify komutu: ${command}`,
    };
  }

  await delay(350);
  return getPopupSpotifyStatus();
}

async function getPopupSpotifyStatus() {
  const tab = await findSpotifyTab();
  if (!tab) {
    return {
      ok: true,
      hasSpotifyTab: false,
      status: null,
      anyVideoPlaying: isAnyVideoPlaying(),
      settings: currentSettings,
    };
  }

  spotifyTabId = tab.id;
  const status = await getSpotifyStatus(tab.id);

  return {
    ok: true,
    hasSpotifyTab: true,
    tabId: tab.id,
    status,
    anyVideoPlaying: isAnyVideoPlaying(),
    settings: currentSettings,
  };
}

function isAnyVideoPlaying() {
  pruneStaleVideoFrames();
  return videoFrames.size > 0;
}

function removeVideoStatesForTab(tabId) {
  let removed = false;

  for (const [key, value] of videoFrames) {
    if (value.tabId === tabId) {
      videoFrames.delete(key);
      removed = true;
    }
  }

  return removed;
}

function pruneStaleVideoFrames() {
  const now = Date.now();
  let removed = false;

  for (const [key, value] of videoFrames) {
    if (!value?.updatedAt || now - value.updatedAt > VIDEO_STATE_TTL_MS) {
      videoFrames.delete(key);
      removed = true;
    }
  }

  return removed;
}

async function restoreVideoFrames() {
  const items = await storageGet(getEphemeralStorageArea(), VIDEO_STATE_KEY);
  const storedFrames = items[VIDEO_STATE_KEY];

  videoFrames.clear();

  if (!Array.isArray(storedFrames)) {
    return;
  }

  for (const entry of storedFrames) {
    if (!entry || typeof entry.key !== 'string' || !isPlainObject(entry.value)) {
      continue;
    }

    videoFrames.set(entry.key, {
      tabId: entry.value.tabId,
      frameId: entry.value.frameId,
      title: entry.value.title || '',
      url: entry.value.url || '',
      reason: entry.value.reason || '',
      activeVideoCount: entry.value.activeVideoCount || 1,
      updatedAt: entry.value.updatedAt || 0,
    });
  }
}

async function persistVideoFrames() {
  const payload = Array.from(videoFrames.entries()).map(([key, value]) => ({
    key,
    value,
  }));

  await storageSet(getEphemeralStorageArea(), {
    [VIDEO_STATE_KEY]: payload,
  });
}

async function setPausedByExtension(value) {
  pausedByExtension = Boolean(value);
  await storageSet('local', {
    [RUNTIME_STATE_KEY]: {
      pausedByExtension,
      updatedAt: Date.now(),
    },
  });
}

async function loadSettings(options = {}) {
  const { seed = false } = options;
  const items = await storageGet('sync', null);
  const normalized = normalizeSettings(items);

  if (seed && shouldSeedSettings(items)) {
    await storageSet('sync', toStoragePayload(normalized));
  }

  return normalized;
}

function normalizeSettings(items = {}) {
  const nested = isPlainObject(items.settings) ? items.settings : {};

  return {
    playlistUrl: normalizeSpotifyPlaylistUrl(firstString(
      nested.playlistUrl,
      items.playlistUrl,
      items.spotifyPlaylistUrl,
      DEFAULT_SETTINGS.playlistUrl,
    )),
    maxVolume: sanitizeVolume(firstDefined(
      nested.maxVolume,
      items.maxVolume,
      items.maxSpotifyVolume,
      DEFAULT_SETTINGS.maxVolume,
    )),
    pauseSpotifyOnVideo: firstBoolean(
      nested.pauseSpotifyOnVideo,
      items.pauseSpotifyOnVideo,
      items.pauseOnVideo,
      DEFAULT_SETTINGS.pauseSpotifyOnVideo,
    ),
    autoOpenSpotify: firstBoolean(
      nested.autoOpenSpotify,
      items.autoOpenSpotify,
      items.openSpotifyOnStartup,
      DEFAULT_SETTINGS.autoOpenSpotify,
    ),
  };
}

function toStoragePayload(settings) {
  return {
    settings,
    playlistUrl: settings.playlistUrl,
    maxVolume: settings.maxVolume,
    pauseSpotifyOnVideo: settings.pauseSpotifyOnVideo,
    autoOpenSpotify: settings.autoOpenSpotify,
  };
}

function shouldSeedSettings(items) {
  if (!items || Object.keys(items).length === 0) {
    return true;
  }

  return !items.settings &&
    items.playlistUrl === undefined &&
    items.maxVolume === undefined &&
    items.pauseSpotifyOnVideo === undefined &&
    items.autoOpenSpotify === undefined;
}

function storageGet(areaName, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[areaName].get(keys, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve(items || {});
    });
  });
}

function storageSet(areaName, value) {
  return new Promise((resolve, reject) => {
    chrome.storage[areaName].set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getEphemeralStorageArea() {
  return chrome.storage.session ? 'session' : 'local';
}

function sanitizeVolume(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return DEFAULT_SETTINGS.maxVolume;
  }

  return Math.min(100, Math.max(0, number));
}

function firstDefined() {
  for (const value of arguments) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function firstString() {
  const value = firstDefined.apply(null, arguments);
  return typeof value === 'string' ? value : '';
}

function firstBoolean() {
  for (const value of arguments) {
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return false;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
