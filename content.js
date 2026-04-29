(() => {
  'use strict';

  if (window.__spotifyVideoSyncContentLoaded) {
    return;
  }
  window.__spotifyVideoSyncContentLoaded = true;

  const MESSAGE_TYPE = 'VIDEO_STATE_CHANGED';
  const LOG_PREFIX = '[Spotify Video Sync]';
  const RECONCILE_INTERVAL_MS = 5000;
  const EVALUATE_DEBOUNCE_MS = 120;
  const TIMEUPDATE_THROTTLE_MS = 900;
  const MIN_CURRENT_TIME_SECONDS = 0.05;
  const HAVE_CURRENT_DATA = 2;
  const HAVE_FUTURE_DATA = 3;
  const MAX_REPORTED_VIDEOS = 5;

  const VIDEO_EVENTS = [
    'play',
    'playing',
    'pause',
    'ended',
    'volumechange',
    'emptied',
    'stalled',
    'waiting',
    'seeked',
    'ratechange',
    'timeupdate',
  ];

  const observedVideos = new Map();
  const videoIds = new WeakMap();

  let nextVideoId = 1;
  let evaluateTimer = 0;
  let lastSentSignature = '';
  let lastTimeupdateAt = 0;
  let observer = null;
  let reconcileInterval = 0;

  function getVideoId(video) {
    if (!videoIds.has(video)) {
      videoIds.set(video, nextVideoId);
      nextVideoId += 1;
    }
    return videoIds.get(video);
  }

  function isTopFrame() {
    try {
      return window.top === window;
    } catch (error) {
      return false;
    }
  }

  function getVideoSource(video) {
    const source = video.currentSrc || video.src || '';
    return source.length > 180 ? `${source.slice(0, 177)}...` : source;
  }

  function getVideoSnapshot(video) {
    return {
      id: getVideoId(video),
      currentTime: Number(video.currentTime.toFixed(2)),
      duration: Number.isFinite(video.duration)
        ? Number(video.duration.toFixed(2))
        : null,
      muted: Boolean(video.muted),
      volume: Number(video.volume.toFixed(2)),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      readyState: video.readyState,
      playbackRate: video.playbackRate,
      src: getVideoSource(video),
    };
  }

  function isVideoActuallyPlaying(video) {
    if (!video || !video.isConnected) {
      return false;
    }

    if (video.paused || video.ended) {
      return false;
    }

    if (video.muted || video.volume <= 0) {
      return false;
    }

    if (video.playbackRate === 0 || video.readyState < HAVE_CURRENT_DATA) {
      return false;
    }

    const hasMoved = video.currentTime > MIN_CURRENT_TIME_SECONDS;
    const hasBufferedPlayback = video.readyState >= HAVE_FUTURE_DATA;
    const isStreamLike = !Number.isFinite(video.duration);

    return hasMoved || hasBufferedPlayback || isStreamLike;
  }

  function getKnownConnectedVideos() {
    return Array.from(observedVideos.keys()).filter((video) => {
      if (video.isConnected) {
        return true;
      }

      unobserveVideo(video);
      return false;
    });
  }

  function buildState(reason) {
    const videos = getKnownConnectedVideos();
    const activeVideos = videos.filter(isVideoActuallyPlaying);

    return {
      type: MESSAGE_TYPE,
      isPlaying: activeVideos.length > 0,
      url: window.location.href,
      title: document.title || '',
      reason,
      visibilityState: document.visibilityState,
      activeVideoCount: activeVideos.length,
      totalVideoCount: videos.length,
      videos: activeVideos.slice(0, MAX_REPORTED_VIDEOS).map(getVideoSnapshot),
      frameUrl: window.location.href,
      isTopFrame: isTopFrame(),
      timestamp: Date.now(),
    };
  }

  function sendMessage(payload) {
    if (
      typeof chrome === 'undefined' ||
      !chrome.runtime ||
      typeof chrome.runtime.sendMessage !== 'function'
    ) {
      return;
    }

    try {
      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      console.debug(LOG_PREFIX, 'Video state message could not be sent.', error);
    }
  }

  function publishState(reason, force = false) {
    const state = buildState(reason);
    const signature = [
      state.isPlaying ? '1' : '0',
      state.activeVideoCount,
      state.isPlaying ? state.url : '',
    ].join('|');

    const shouldForceHeartbeat = force && (state.isPlaying || lastSentSignature.startsWith('1|'));

    if (!shouldForceHeartbeat && signature === lastSentSignature) {
      return;
    }

    lastSentSignature = signature;
    sendMessage(state);
  }

  function scheduleEvaluate(reason, delay = EVALUATE_DEBOUNCE_MS) {
    if (evaluateTimer) {
      clearTimeout(evaluateTimer);
    }

    evaluateTimer = window.setTimeout(() => {
      evaluateTimer = 0;
      publishState(reason);
    }, delay);
  }

  function handleVideoEvent(event) {
    if (event.type === 'timeupdate') {
      const now = Date.now();
      if (now - lastTimeupdateAt < TIMEUPDATE_THROTTLE_MS) {
        return;
      }
      lastTimeupdateAt = now;
    }

    scheduleEvaluate(event.type);
  }

  function observeVideo(video) {
    if (!(video instanceof HTMLVideoElement) || observedVideos.has(video)) {
      return;
    }

    getVideoId(video);

    const controller = new AbortController();
    observedVideos.set(video, controller);

    for (const eventName of VIDEO_EVENTS) {
      video.addEventListener(eventName, handleVideoEvent, {
        passive: true,
        signal: controller.signal,
      });
    }
  }

  function unobserveVideo(video) {
    const controller = observedVideos.get(video);
    if (!controller) {
      return;
    }

    controller.abort();
    observedVideos.delete(video);
  }

  function findVideosInNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }

    const element = node;
    const videos = [];

    if (element instanceof HTMLVideoElement) {
      videos.push(element);
    }

    if (typeof element.querySelectorAll === 'function') {
      videos.push(...element.querySelectorAll('video'));
    }

    return videos;
  }

  function scanForVideos() {
    const currentVideos = new Set(document.querySelectorAll('video'));

    for (const video of currentVideos) {
      observeVideo(video);
    }

    for (const video of observedVideos.keys()) {
      if (!currentVideos.has(video) || !video.isConnected) {
        unobserveVideo(video);
      }
    }
  }

  function handleMutations(mutations) {
    let touchedVideos = false;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const videos = findVideosInNode(node);
        if (videos.length > 0) {
          touchedVideos = true;
          videos.forEach(observeVideo);
        }
      }

      for (const node of mutation.removedNodes) {
        const videos = findVideosInNode(node);
        if (videos.length > 0) {
          touchedVideos = true;
          videos.forEach(unobserveVideo);
        }
      }
    }

    if (touchedVideos) {
      scheduleEvaluate('mutation');
    }
  }

  function start() {
    scanForVideos();

    observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });

    document.addEventListener(
      'visibilitychange',
      () => scheduleEvaluate('visibilitychange', 250),
      { passive: true },
    );

    window.addEventListener(
      'pagehide',
      (event) => {
        publishStoppedOnExit('pagehide', { cleanup: !event.persisted });
      },
      { capture: true },
    );

    window.addEventListener(
      'beforeunload',
      () => {
        publishStoppedOnExit('beforeunload', { cleanup: true });
      },
      { capture: true },
    );

    window.addEventListener(
      'pageshow',
      () => {
        scanForVideos();
        scheduleEvaluate('pageshow');
      },
      { passive: true },
    );

    reconcileInterval = window.setInterval(() => {
      scanForVideos();
      publishState('reconcile', true);
    }, RECONCILE_INTERVAL_MS);

    scheduleEvaluate('init', 0);
  }

  function publishStoppedOnExit(reason, options) {
    if (evaluateTimer) {
      clearTimeout(evaluateTimer);
      evaluateTimer = 0;
    }

    lastSentSignature = '0|0|';

    sendMessage({
      type: MESSAGE_TYPE,
      isPlaying: false,
      url: window.location.href,
      title: document.title || '',
      reason,
      visibilityState: document.visibilityState,
      activeVideoCount: 0,
      totalVideoCount: 0,
      videos: [],
      frameUrl: window.location.href,
      isTopFrame: isTopFrame(),
      timestamp: Date.now(),
    });

    if (!options.cleanup) {
      return;
    }

    if (reconcileInterval) {
      clearInterval(reconcileInterval);
      reconcileInterval = 0;
    }

    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
