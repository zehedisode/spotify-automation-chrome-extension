const SPOTIFY_HOME_URL = 'https://open.spotify.com/';
const SPOTIFY_TAB_QUERY = 'https://open.spotify.com/*';
const LOG_PREFIX = '[Spotify Video Sync]';

export { SPOTIFY_HOME_URL };

export function isSpotifyUrl(url) {
  try {
    return new URL(url).hostname === 'open.spotify.com';
  } catch (error) {
    return false;
  }
}

export function normalizeSpotifyPlaylistUrl(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
      return '';
    }

    if (!url.pathname.startsWith('/playlist/')) {
      return '';
    }

    return url.toString();
  } catch (error) {
    return '';
  }
}

export async function findSpotifyTab() {
  const tabs = await chrome.tabs.query({ url: SPOTIFY_TAB_QUERY });
  return pickSpotifyTab(tabs);
}

export async function ensureSpotifyTab(options = {}) {
  const {
    create = false,
    preferredUrl = SPOTIFY_HOME_URL,
    active = false,
  } = options;

  const existing = await findSpotifyTab();
  if (existing) {
    let usableTab = existing;

    if (existing.discarded) {
      try {
        await chrome.tabs.reload(existing.id);
        usableTab = await waitForTabComplete(existing.id, 20000) || existing;
      } catch (error) {
        usableTab = existing;
      }
    }

    if (active) {
      try {
        await focusTabWindow(usableTab);
        return await chrome.tabs.update(usableTab.id, { active: true });
      } catch (error) {
        return usableTab;
      }
    }

    return usableTab;
  }

  if (!create) {
    return null;
  }

  const tab = await chrome.tabs.create({
    url: preferredUrl || SPOTIFY_HOME_URL,
    active: Boolean(active),
  });

  if (active) {
    await focusTabWindow(tab);
  }

  return tab;
}

export async function openSpotifyUrl(tabId, url) {
  const safeUrl = normalizeSpotifyUrl(url);
  if (!safeUrl) {
    return null;
  }

  const tab = await getTab(tabId);
  if (!tab) {
    return null;
  }

  if (sameUrlWithoutHash(tab.url, safeUrl)) {
    return tab;
  }

  await chrome.tabs.update(tabId, { url: safeUrl });
  return waitForTabComplete(tabId, 20000);
}

export async function getSpotifyStatus(tabId) {
  await waitForSpotifyDocument(tabId, 6000);
  const status = await executeSpotifyScript(tabId, spotifyStatusProbe);

  return status || {
    found: false,
    isPlaying: false,
    label: '',
    mediaCount: 0,
  };
}

export async function pauseSpotify(tabId) {
  return setSpotifyPlayback(tabId, false);
}

export async function resumeSpotify(tabId) {
  return setSpotifyPlayback(tabId, true);
}

export async function startSpotifyPlayback(tabId, options = {}) {
  const {
    attempts = 5,
    delayMs = 1400,
    preferContextPlay = false,
    readyTimeoutMs = 45000,
  } = options;

  await waitForSpotifyPlayer(tabId, readyTimeoutMs);

  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = await executeSpotifyScript(tabId, spotifyStartPlayback, [preferContextPlay]);
    await delay(delayMs);

    const status = await getSpotifyStatus(tabId);
    if (status.isPlaying) {
      return {
        ...(lastResult || {}),
        attempt,
        status,
      };
    }

    if (lastResult?.method === 'not-found') {
      await waitForSpotifyPlayer(tabId, delayMs);
    }
  }

  return {
    ...(lastResult || {}),
    attempt: attempts,
    status: await getSpotifyStatus(tabId),
  };
}

export async function setSpotifyMaxVolume(tabId, maxVolume) {
  await waitForSpotifyDocument(tabId, 6000);
  return executeSpotifyScript(tabId, spotifySetMaxVolume, [clampVolume(maxVolume)]);
}

export async function setSpotifyVolume(tabId, volume) {
  await waitForSpotifyDocument(tabId, 6000);
  return executeSpotifyScript(tabId, spotifySetVolume, [clampVolume(volume)]);
}

export async function skipSpotifyTrack(tabId) {
  return clickSpotifyControl(tabId, 'next');
}

export async function previousSpotifyTrack(tabId) {
  return clickSpotifyControl(tabId, 'previous');
}

async function setSpotifyPlayback(tabId, shouldPlay) {
  await waitForSpotifyDocument(tabId, 8000);
  const result = await executeSpotifyScript(tabId, spotifySetPlayback, [shouldPlay]);
  await delay(500);
  const status = await getSpotifyStatus(tabId);

  return {
    ...(result || {}),
    status,
  };
}

async function clickSpotifyControl(tabId, command) {
  await waitForSpotifyDocument(tabId, 8000);
  const result = await executeSpotifyScript(tabId, spotifyClickControl, [command]);
  await delay(500);
  const status = await getSpotifyStatus(tabId);

  return {
    ...(result || {}),
    status,
  };
}

async function executeSpotifyScript(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });

    return results && results[0] ? results[0].result : null;
  } catch (error) {
    console.warn(LOG_PREFIX, 'Spotify script could not run.', error);
    return null;
  }
}

async function waitForSpotifyDocument(tabId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await executeSpotifyScript(tabId, () => ({
      body: Boolean(document.body),
      host: location.hostname,
      readyState: document.readyState,
    }));

    if (
      snapshot &&
      snapshot.host === 'open.spotify.com' &&
      snapshot.body &&
      snapshot.readyState !== 'loading'
    ) {
      return true;
    }

    await delay(350);
  }

  return false;
}

async function waitForSpotifyPlayer(tabId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await waitForSpotifyDocument(tabId, 4000);
    const status = await executeSpotifyScript(tabId, spotifyPlayerProbe);

    if (status?.hasPlayableControl || status?.isPlaying) {
      return true;
    }

    await delay(600);
  }

  return false;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await getTab(tabId);
    if (!tab) {
      return null;
    }

    if (tab.status === 'complete') {
      return tab;
    }

    await delay(300);
  }

  return getTab(tabId);
}

function spotifyPlayerProbe() {
  const controls = findPlayableControls();
  const media = Array.from(document.querySelectorAll('audio, video'));

  return {
    hasPlayableControl: controls.length > 0,
    isPlaying: media.some((element) => !element.paused && !element.ended),
    controlCount: controls.length,
    readyState: document.readyState,
    url: location.href,
  };

  function findPlayableControls() {
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((element) => isVisible(element) && !isDisabled(element))
      .filter((element) => {
        const label = getLabel(element);
        const testId = element.getAttribute('data-testid') || '';
        return testId === 'control-button-playpause' ||
          testId === 'play-button' ||
          /(play|oynat|resume|devam)/i.test(label);
      });
  }

  function getLabel(element) {
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function isDisabled(element) {
    return Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true';
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

async function focusTabWindow(tab) {
  if (!tab || !Number.isInteger(tab.windowId) || !chrome.windows?.update) {
    return;
  }

  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    // Window focus is best-effort; playback still falls back to DOM controls.
  }
}

function pickSpotifyTab(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return null;
  }

  return tabs
    .slice()
    .sort((a, b) => Number(b.active) - Number(a.active) || b.id - a.id)[0];
}

function normalizeSpotifyUrl(value) {
  if (!value || typeof value !== 'string') {
    return SPOTIFY_HOME_URL;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
      return SPOTIFY_HOME_URL;
    }

    return url.toString();
  } catch (error) {
    return SPOTIFY_HOME_URL;
  }
}

function sameUrlWithoutHash(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = '';
    rightUrl.hash = '';
    return leftUrl.toString() === rightUrl.toString();
  } catch (error) {
    return false;
  }
}

function clampVolume(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return 50;
  }

  return Math.min(100, Math.max(0, number));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function spotifyStatusProbe() {
  const button = findPlayPauseButton();
  const label = getElementLabel(button);
  const media = getMediaElements();
  const labelState = playbackStateFromLabel(label);
  const mediaState = media.some((element) => !element.paused && !element.ended);
  const isPlaying = labelState === null ? mediaState : labelState;
  const track = readNowPlaying();
  const volume = readVolumePercent(media);

  return {
    found: Boolean(button || media.length),
    isPlaying: Boolean(isPlaying),
    label,
    mediaCount: media.length,
    trackTitle: track.title,
    artist: track.artist,
    volume,
    url: location.href,
  };

  function findPlayPauseButton() {
    const selectors = [
      '[data-testid="control-button-playpause"]',
      'button[aria-label*="Pause" i]',
      'button[aria-label*="Play" i]',
      'button[aria-label*="Duraklat" i]',
      'button[aria-label*="Oynat" i]',
      'button[title*="Pause" i]',
      'button[title*="Play" i]',
    ];

    for (const selector of selectors) {
      const element = safeQuery(selector);
      if (element) {
        return element;
      }
    }

    return null;
  }

  function getElementLabel(element) {
    if (!element) {
      return '';
    }

    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function playbackStateFromLabel(value) {
    const labelValue = String(value || '').toLowerCase();
    if (!labelValue) {
      return null;
    }

    if (/(pause|duraklat|pausar|pausa)/.test(labelValue)) {
      return true;
    }

    if (/(play|oynat|reproducir|riproduci)/.test(labelValue)) {
      return false;
    }

    return null;
  }

  function getMediaElements() {
    return Array.from(document.querySelectorAll('audio, video'));
  }

  function readNowPlaying() {
    const titleSelectors = [
      '[data-testid="context-item-info-title"]',
      '[data-testid="now-playing-widget"] a[href*="/track/"]',
      '[data-testid="now-playing-bar"] a[href*="/track/"]',
      'footer a[href*="/track/"]',
    ];
    const artistSelectors = [
      '[data-testid="context-item-info-artist"]',
      '[data-testid="now-playing-widget"] a[href*="/artist/"]',
      '[data-testid="now-playing-bar"] a[href*="/artist/"]',
      'footer a[href*="/artist/"]',
    ];

    return {
      title: readText(titleSelectors),
      artist: readText(artistSelectors),
    };
  }

  function readText(selectors) {
    for (const selector of selectors) {
      const element = safeQuery(selector);
      const text = element && element.textContent ? element.textContent.trim() : '';
      if (text) {
        return text;
      }
    }

    return '';
  }

  function readVolumePercent(mediaElements) {
    const slider = findVolumeControl();
    const sliderPercent = slider ? readSliderPercent(slider) : null;
    if (sliderPercent !== null) {
      return Math.round(sliderPercent);
    }

    const audible = mediaElements.find((element) => typeof element.volume === 'number');
    if (!audible) {
      return null;
    }

    return Math.round(audible.volume * 100);
  }

  function findVolumeControl() {
    const selectors = [
      '[data-testid="volume-bar"] input[type="range"]',
      'input[type="range"][aria-label*="Volume" i]',
      'input[type="range"][aria-label*="Ses" i]',
      '[data-testid="volume-bar"] [role="slider"]',
      '[role="slider"][aria-label*="Volume" i]',
      '[role="slider"][aria-label*="Ses" i]',
      '[data-testid="volume-bar"]',
    ];

    for (const selector of selectors) {
      const element = safeQuery(selector);
      if (element) {
        return element;
      }
    }

    return null;
  }

  function readSliderPercent(element) {
    if (element instanceof HTMLInputElement) {
      const min = Number.parseFloat(element.min || '0');
      const max = Number.parseFloat(element.max || '100');
      const value = Number.parseFloat(element.value || '0');
      if (Number.isFinite(min) && Number.isFinite(max) && max > min && Number.isFinite(value)) {
        return ((value - min) / (max - min)) * 100;
      }
    }

    const ariaNow = Number.parseFloat(element.getAttribute('aria-valuenow') || '');
    const ariaMax = Number.parseFloat(element.getAttribute('aria-valuemax') || '100');
    if (Number.isFinite(ariaNow)) {
      return ariaMax <= 1 ? ariaNow * 100 : ariaNow;
    }

    return null;
  }

  function safeQuery(selector) {
    try {
      return document.querySelector(selector);
    } catch (error) {
      return null;
    }
  }
}

function spotifySetPlayback(shouldPlay) {
  const button = findPlayPauseButton();
  const currentState = getCurrentPlaybackState(button);

  if (currentState === shouldPlay) {
    return {
      changed: false,
      method: 'already-correct',
      currentState,
    };
  }

  if (button && !button.disabled) {
    button.click();
    return {
      changed: true,
      method: 'play-pause-button',
      previousState: currentState,
    };
  }

  const media = Array.from(document.querySelectorAll('audio, video'));
  if (media.length > 0) {
    for (const element of media) {
      if (shouldPlay && typeof element.play === 'function') {
        element.play().catch(() => {});
      } else if (!shouldPlay && typeof element.pause === 'function') {
        element.pause();
      }
    }

    return {
      changed: true,
      method: 'media-element',
      previousState: currentState,
    };
  }

  return {
    changed: false,
    method: 'not-found',
    previousState: currentState,
  };

  function findPlayPauseButton() {
    const selectors = [
      '[data-testid="control-button-playpause"]',
      'button[aria-label*="Pause" i]',
      'button[aria-label*="Play" i]',
      'button[aria-label*="Duraklat" i]',
      'button[aria-label*="Oynat" i]',
      'button[title*="Pause" i]',
      'button[title*="Play" i]',
    ];

    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  function getCurrentPlaybackState(element) {
    const label = [
      element && element.getAttribute('aria-label'),
      element && element.getAttribute('title'),
      element && element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (/(pause|duraklat|pausar|pausa)/.test(label)) {
      return true;
    }

    if (/(play|oynat|reproducir|riproduci)/.test(label)) {
      return false;
    }

    const media = Array.from(document.querySelectorAll('audio, video'));
    if (media.some((item) => !item.paused && !item.ended)) {
      return true;
    }

    if (media.length > 0) {
      return false;
    }

    return null;
  }
}

function spotifyStartPlayback(preferContextPlay) {
  const statusBefore = getCurrentPlaybackState(findPlayerButton());

  if (statusBefore === true) {
    return {
      changed: false,
      method: 'already-playing',
      previousState: statusBefore,
    };
  }

  if (preferContextPlay) {
    const contextButton = findContextPlayButton();
    if (contextButton) {
      contextButton.click();
      return {
        changed: true,
        method: 'context-play-button',
        label: getLabel(contextButton),
        previousState: statusBefore,
      };
    }
  }

  const playerButton = findPlayerButton();
  if (playerButton && !isDisabled(playerButton)) {
    playerButton.click();
    return {
      changed: true,
      method: 'player-play-button',
      label: getLabel(playerButton),
      previousState: statusBefore,
    };
  }

  const media = Array.from(document.querySelectorAll('audio, video'));
  for (const element of media) {
    if (typeof element.play === 'function') {
      element.play().catch(() => {});
    }
  }

  if (media.length > 0) {
    return {
      changed: true,
      method: 'media-element',
      previousState: statusBefore,
    };
  }

  return {
    changed: false,
    method: 'not-found',
    previousState: statusBefore,
  };

  function findContextPlayButton() {
    const candidates = Array.from(document.querySelectorAll([
      'main [data-testid="play-button"]',
      '[data-testid="action-bar-row"] [data-testid="play-button"]',
      'main button[aria-label*="Play" i]',
      'main button[aria-label*="Oynat" i]',
      'main [role="button"][aria-label*="Play" i]',
      'main [role="button"][aria-label*="Oynat" i]',
    ].join(',')));

    return candidates
      .filter((element) => isVisible(element) && !isDisabled(element))
      .filter((element) => {
        const label = getLabel(element);
        const testId = element.getAttribute('data-testid') || '';
        return testId === 'play-button' || /(play|oynat|resume|devam)/i.test(label);
      })
      .sort((left, right) => area(right) - area(left))[0] || null;
  }

  function findPlayerButton() {
    const selectors = [
      '[data-testid="control-button-playpause"]',
      '[data-testid="now-playing-bar"] button[aria-label*="Pause" i]',
      '[data-testid="now-playing-bar"] button[aria-label*="Play" i]',
      '[data-testid="now-playing-bar"] button[aria-label*="Duraklat" i]',
      '[data-testid="now-playing-bar"] button[aria-label*="Oynat" i]',
      'footer button[aria-label*="Pause" i]',
      'footer button[aria-label*="Play" i]',
      'footer button[aria-label*="Duraklat" i]',
      'footer button[aria-label*="Oynat" i]',
    ];

    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element && isVisible(element)) {
          return element;
        }
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  function getCurrentPlaybackState(element) {
    const label = getLabel(element).toLowerCase();

    if (/(pause|duraklat|pausar|pausa)/.test(label)) {
      return true;
    }

    if (/(play|oynat|reproducir|riproduci)/.test(label)) {
      return false;
    }

    const media = Array.from(document.querySelectorAll('audio, video'));
    if (media.some((item) => !item.paused && !item.ended)) {
      return true;
    }

    if (media.length > 0) {
      return false;
    }

    return null;
  }

  function getLabel(element) {
    if (!element) {
      return '';
    }

    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function isDisabled(element) {
    return Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true';
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
  }

  function area(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }
}

function spotifyClickControl(command) {
  const selectorsByCommand = {
    next: [
      '[data-testid="control-button-skip-forward"]',
      'button[aria-label*="Next" i]',
      'button[aria-label*="Sonraki" i]',
      'button[title*="Next" i]',
      'button[title*="Sonraki" i]',
    ],
    previous: [
      '[data-testid="control-button-skip-back"]',
      'button[aria-label*="Previous" i]',
      'button[aria-label*="Önceki" i]',
      'button[aria-label*="Onceki" i]',
      'button[title*="Previous" i]',
      'button[title*="Önceki" i]',
      'button[title*="Onceki" i]',
    ],
  };

  const selectors = selectorsByCommand[command] || [];
  for (const selector of selectors) {
    try {
      const button = document.querySelector(selector);
      if (button && !isDisabled(button) && isVisible(button)) {
        button.click();
        return {
          changed: true,
          method: `${command}-button`,
          label: getLabel(button),
        };
      }
    } catch (error) {
      return {
        changed: false,
        method: 'selector-error',
        error: error.message,
      };
    }
  }

  return {
    changed: false,
    method: 'not-found',
    command,
  };

  function getLabel(element) {
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function isDisabled(element) {
    return Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true';
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
  }
}

function spotifySetMaxVolume(maxVolume) {
  const targetPercent = Math.min(100, Math.max(0, Number(maxVolume) || 0));
  const targetFraction = targetPercent / 100;
  const media = Array.from(document.querySelectorAll('audio, video'));
  const result = {
    targetPercent,
    mediaAdjusted: false,
    sliderAdjusted: false,
    currentPercent: null,
  };

  for (const element of media) {
    if (typeof element.volume === 'number' && element.volume > targetFraction) {
      element.volume = targetFraction;
      element.dispatchEvent(new Event('volumechange', { bubbles: true }));
      result.mediaAdjusted = true;
    }
  }

  const slider = findVolumeControl();
  if (!slider) {
    return result;
  }

  const currentPercent = readSliderPercent(slider);
  result.currentPercent = currentPercent;

  if (currentPercent !== null && currentPercent <= targetPercent + 1) {
    return result;
  }

  result.sliderAdjusted = applySliderValue(slider, targetPercent);
  return result;

  function findVolumeControl() {
    const selectors = [
      '[data-testid="volume-bar"] input[type="range"]',
      'input[type="range"][aria-label*="Volume" i]',
      'input[type="range"][aria-label*="Ses" i]',
      '[data-testid="volume-bar"] [role="slider"]',
      '[role="slider"][aria-label*="Volume" i]',
      '[role="slider"][aria-label*="Ses" i]',
      '[data-testid="volume-bar"]',
    ];

    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  function readSliderPercent(element) {
    if (element instanceof HTMLInputElement) {
      const min = Number.parseFloat(element.min || '0');
      const max = Number.parseFloat(element.max || '100');
      const value = Number.parseFloat(element.value || '0');
      if (Number.isFinite(min) && Number.isFinite(max) && max > min && Number.isFinite(value)) {
        return ((value - min) / (max - min)) * 100;
      }
    }

    const ariaNow = Number.parseFloat(element.getAttribute('aria-valuenow') || '');
    const ariaMax = Number.parseFloat(element.getAttribute('aria-valuemax') || '100');
    if (Number.isFinite(ariaNow)) {
      return ariaMax <= 1 ? ariaNow * 100 : ariaNow;
    }

    return null;
  }

  function applySliderValue(element, percent) {
    if (element instanceof HTMLInputElement) {
      const min = Number.parseFloat(element.min || '0');
      const max = Number.parseFloat(element.max || '100');
      const value = min + ((max - min) * percent) / 100;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

      if (descriptor && descriptor.set) {
        descriptor.set.call(element, String(value));
      } else {
        element.value = String(value);
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const clientX = rect.left + rect.width * (percent / 100);
    const clientY = rect.top + rect.height / 2;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'mouse',
    };

    for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventClass = eventName.startsWith('pointer') && window.PointerEvent
        ? window.PointerEvent
        : window.MouseEvent;
      element.dispatchEvent(new EventClass(eventName, eventOptions));
    }

    return true;
  }
}

function spotifySetVolume(volume) {
  const targetPercent = Math.min(100, Math.max(0, Number(volume) || 0));
  const targetFraction = targetPercent / 100;
  const media = Array.from(document.querySelectorAll('audio, video'));
  const result = {
    targetPercent,
    mediaAdjusted: false,
    sliderAdjusted: false,
  };

  for (const element of media) {
    if (typeof element.volume === 'number') {
      element.volume = targetFraction;
      element.dispatchEvent(new Event('volumechange', { bubbles: true }));
      result.mediaAdjusted = true;
    }
  }

  const slider = findVolumeControl();
  if (!slider) {
    return result;
  }

  result.sliderAdjusted = applySliderValue(slider, targetPercent);
  return result;

  function findVolumeControl() {
    const selectors = [
      '[data-testid="volume-bar"] input[type="range"]',
      'input[type="range"][aria-label*="Volume" i]',
      'input[type="range"][aria-label*="Ses" i]',
      '[data-testid="volume-bar"] [role="slider"]',
      '[role="slider"][aria-label*="Volume" i]',
      '[role="slider"][aria-label*="Ses" i]',
      '[data-testid="volume-bar"]',
    ];

    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  function applySliderValue(element, percent) {
    if (element instanceof HTMLInputElement) {
      const min = Number.parseFloat(element.min || '0');
      const max = Number.parseFloat(element.max || '100');
      const value = min + ((max - min) * percent) / 100;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

      if (descriptor && descriptor.set) {
        descriptor.set.call(element, String(value));
      } else {
        element.value = String(value);
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const clientX = rect.left + rect.width * (percent / 100);
    const clientY = rect.top + rect.height / 2;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'mouse',
    };

    for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventClass = eventName.startsWith('pointer') && window.PointerEvent
        ? window.PointerEvent
        : window.MouseEvent;
      element.dispatchEvent(new EventClass(eventName, eventOptions));
    }

    return true;
  }
}
