(() => {
  'use strict';

  if (window.__spotifyVideoSyncBarLoaded) {
    return;
  }
  window.__spotifyVideoSyncBarLoaded = true;

  const DEFAULT_SETTINGS = Object.freeze({
    playlistUrl: '',
    maxVolume: 50,
    pauseSpotifyOnVideo: true,
    autoOpenSpotify: true,
    autoHide: true,
    autoHideDelay: 2,
    autoShowOnVideo: true,
  });

  const ICON_URL = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('icons/icon.svg')
    : 'icons/icon.svg';

  let container = null;
  let trigger = null;
  let statusTimer = 0;
  let volumeTimer = 0;
  let autoHideTimer = 0;
  let toastTimer = 0;
  let currentSettings = { ...DEFAULT_SETTINGS };
  let lastToastVideoPlaying = null;

  const els = {};

  function createDOM() {
    if (document.getElementById('svs-bar-container')) {
      return;
    }

    trigger = document.createElement('button');
    trigger.id = 'svs-trigger';
    trigger.title = 'Spotify Video Sync';
    trigger.setAttribute('aria-label', 'Spotify Video Sync barını aç/kapat');
    trigger.innerHTML = `<img src="${escapeHtml(ICON_URL)}" alt="" aria-hidden="true">`;
    document.body.appendChild(trigger);

    container = document.createElement('div');
    container.id = 'svs-bar-container';
    container.dataset.open = 'false';
    container.dataset.expanded = 'false';
    container.dataset.pinned = 'false';
    container.innerHTML = `
      <div class="svs-bar-wrap">
        <div class="svs-bar">
          <div class="svs-bar-brand">
            <img src="${escapeHtml(ICON_URL)}" alt="">
            <div class="svs-bar-track">
              <strong id="svs-trackTitle">Parça bilgisi yok</strong>
              <small id="svs-trackArtist">Spotify Web</small>
            </div>
          </div>
          <div class="svs-bar-center">
            <button class="svs-btn svs-btn-ghost" id="svs-prev" title="Önceki parça (Ctrl+Shift+B)" aria-label="Önceki parça">‹‹</button>
            <button class="svs-btn svs-btn-primary" id="svs-playPause" title="Oynat / Duraklat (Ctrl+Shift+P)">Oynat</button>
            <button class="svs-btn svs-btn-ghost" id="svs-next" title="Sonraki parça (Ctrl+Shift+N)" aria-label="Sonraki parça">››</button>
            <div class="svs-volume-compact" title="Ses sınırı">
              <button class="svs-btn svs-btn-ghost svs-vol-mini" id="svs-volDown" aria-label="Ses -10">-</button>
              <input type="range" id="svs-maxVolume" min="0" max="100" step="1" aria-label="Ses sınırı">
              <button class="svs-btn svs-btn-ghost svs-vol-mini" id="svs-volUp" aria-label="Ses +10">+</button>
              <span class="svs-vol-value" id="svs-volValue">50</span>
            </div>
          </div>
          <div class="svs-bar-meta">
            <span class="svs-pill" id="svs-videoState">Video yok</span>
            <button class="svs-btn svs-btn-ghost" id="svs-pin" title="Sabitle" aria-label="Sabitle">&#128204;</button>
            <button class="svs-btn svs-btn-ghost" id="svs-settings" title="Ayarlar" aria-label="Ayarlar">&#9881;</button>
            <button class="svs-btn svs-btn-ghost" id="svs-close" title="Kapat (Esc)" aria-label="Kapat">&#10005;</button>
          </div>
        </div>
        <div class="svs-toolbar" id="svs-toolbar">
          <div class="svs-group">
            <span class="svs-label-mini">Kapanış</span>
            <input type="range" id="svs-autoHideDelay" min="1" max="10" step="1" title="Oto-kapanış süresi (sn)">
            <span class="svs-delay-value" id="svs-delayValue">2s</span>
          </div>
          <div class="svs-divider" aria-hidden="true"></div>
          <input class="svs-input" id="svs-playlistUrl" type="url" placeholder="Playlist URL...">
          <div class="svs-divider" aria-hidden="true"></div>
          <label class="svs-check" for="svs-pauseOnVideo" title="Video başladığında Spotify durur">
            <input id="svs-pauseOnVideo" type="checkbox">
            <span>Video senkronu</span>
          </label>
          <label class="svs-check" for="svs-autoOpen" title="Gerekirse arka planda hazırlar">
            <input id="svs-autoOpen" type="checkbox">
            <span>Spotify sekmesi</span>
          </label>
          <label class="svs-check" for="svs-autoHide" title="Bar kısa süre sonra otomatik kapanır">
            <input id="svs-autoHide" type="checkbox">
            <span>Oto-kapanış</span>
          </label>
          <label class="svs-check" for="svs-autoShowOnVideo" title="Video başladığında bar otomatik açılır">
            <input id="svs-autoShowOnVideo" type="checkbox">
            <span>Video tespitinde aç</span>
          </label>
          <div class="svs-divider" aria-hidden="true"></div>
          <button class="svs-btn" id="svs-openSpotify" type="button">Spotify Web'i aç</button>
          <button class="svs-btn" id="svs-loadPlaylist" type="button">Playlist yükle</button>
          <button class="svs-btn svs-btn-primary" id="svs-save" type="button">Kaydet</button>
          <div class="svs-divider" aria-hidden="true"></div>
          <button class="svs-btn" id="svs-help" type="button" title="Bilgi">?</button>
        </div>
        <div class="svs-status" id="svs-status" role="status" aria-live="polite"></div>
      </div>
    `;
    document.body.appendChild(container);

    const modal = document.createElement('div');
    modal.id = 'svs-modal';
    modal.className = 'svs-modal';
    modal.innerHTML = `
      <div class="svs-modal-backdrop" id="svs-modalBackdrop"></div>
      <div class="svs-modal-panel">
        <div class="svs-modal-header">
          <h2>Spotify Video Sync</h2>
          <button class="svs-btn svs-btn-ghost" id="svs-modalClose" title="Kapat">&#10005;</button>
        </div>
        <div class="svs-modal-body">
          <section class="svs-modal-section">
            <h3>Klavye Kısayolları</h3>
            <div class="svs-shortcuts">
              <div class="svs-shortcut"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> <span>Bar aç / kapat</span></div>
              <div class="svs-shortcut"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> <span>Oynat / Duraklat</span></div>
              <div class="svs-shortcut"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> <span>Sonraki parça</span></div>
              <div class="svs-shortcut"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> <span>Önceki parça</span></div>
            </div>
          </section>
          <section class="svs-modal-section">
            <h3>Özellikler</h3>
            <ul class="svs-feature-list">
              <li><strong>Video Senkronu:</strong> Video başladığında Spotify otomatik duraklar.</li>
              <li><strong>Oto-Kapanış:</strong> Bar belirli süre sonra otomatik kapanır.</li>
              <li><strong>Video Tespitinde Aç:</strong> Video algılandığında bar otomatik belirir.</li>
              <li><strong>Sürükleme:</strong> Tetikleyici butonu mouse ile tutup istediğiniz yere bırakabilirsiniz.</li>
              <li><strong>Sabitleme:</strong> Pin butonu ile bar'ı sabitleyebilirsiniz.</li>
            </ul>
          </section>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    els.playlistUrl = document.getElementById('svs-playlistUrl');
    els.maxVolume = document.getElementById('svs-maxVolume');
    els.volValue = document.getElementById('svs-volValue');
    els.pauseOnVideo = document.getElementById('svs-pauseOnVideo');
    els.autoOpen = document.getElementById('svs-autoOpen');
    els.autoHide = document.getElementById('svs-autoHide');
    els.autoShowOnVideo = document.getElementById('svs-autoShowOnVideo');
    els.autoHideDelay = document.getElementById('svs-autoHideDelay');
    els.delayValue = document.getElementById('svs-delayValue');
    els.pin = document.getElementById('svs-pin');
    els.status = document.getElementById('svs-status');
    els.trackTitle = document.getElementById('svs-trackTitle');
    els.trackArtist = document.getElementById('svs-trackArtist');
    els.videoState = document.getElementById('svs-videoState');
    els.playPause = document.getElementById('svs-playPause');

    document.getElementById('svs-prev').addEventListener('click', () => sendSpotifyCommand('previous', 'Önceki parça...'));
    document.getElementById('svs-next').addEventListener('click', () => sendSpotifyCommand('next', 'Sonraki parça...'));
    document.getElementById('svs-playPause').addEventListener('click', () => sendSpotifyCommand('playPause', 'Komut gönderiliyor...'));
    document.getElementById('svs-openSpotify').addEventListener('click', () => sendSpotifyCommand('open', 'Spotify açılıyor...'));
    document.getElementById('svs-loadPlaylist').addEventListener('click', () => sendSpotifyCommand('applyPlaylist', 'Playlist yükleniyor...'));
    document.getElementById('svs-save').addEventListener('click', saveSettings);
    document.getElementById('svs-volDown').addEventListener('click', () => bumpVolume(-10));
    document.getElementById('svs-volUp').addEventListener('click', () => bumpVolume(10));
    document.getElementById('svs-settings').addEventListener('click', toggleToolbar);
    document.getElementById('svs-close').addEventListener('click', closeBar);
    document.getElementById('svs-help').addEventListener('click', openModal);
    document.getElementById('svs-modalClose').addEventListener('click', closeModal);
    document.getElementById('svs-modalBackdrop').addEventListener('click', closeModal);
    els.pin.addEventListener('click', togglePin);

    // Trigger click handled inside makeTriggerDraggable to avoid drag/click conflict

    els.maxVolume.addEventListener('input', () => {
      syncVolume(els.maxVolume.value);
      queueVolumeApply();
    });

    els.autoHideDelay.addEventListener('input', () => {
      const val = sanitizeAutoHideDelay(els.autoHideDelay.value);
      els.delayValue.textContent = `${val}s`;
      currentSettings.autoHideDelay = val;
      if (hasStorage()) {
        setStorage(toStoragePayload(currentSettings)).catch(() => {});
      }
      startAutoHide();
    });

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleOutsideClick);

    if (container) {
      container.addEventListener('mouseenter', stopAutoHide);
      container.addEventListener('mouseleave', startAutoHide);
      container.addEventListener('focusin', stopAutoHide);
      container.addEventListener('focusout', startAutoHide);
    }

    makeTriggerDraggable();

    if (hasRuntime()) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function handleRuntimeMessage(message) {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'BAR_VIDEO_STATE') {
      const isPlaying = Boolean(message.isPlaying);
      els.videoState.textContent = isPlaying ? 'Video aktif' : 'Video yok';
      els.videoState.dataset.active = isPlaying ? 'true' : 'false';

      if (isPlaying && currentSettings.autoShowOnVideo && container.dataset.open !== 'true') {
        openBar();
        showToast('Video tespit edildi — bar açıldı', 'info');
      }

      if (isPlaying !== lastToastVideoPlaying) {
        if (isPlaying) {
          showToast('Video oynatılıyor — Spotify duraklatıldı', 'info');
        } else if (lastToastVideoPlaying === true) {
          showToast('Video durdu — Spotify devam ediyor', 'success');
        }
        lastToastVideoPlaying = isPlaying;
      }
    }
  }

  function showToast(text, type = 'info') {
    let toast = document.getElementById('svs-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'svs-toast';
      document.body.appendChild(toast);
    }

    window.clearTimeout(toastTimer);
    toast.textContent = text;
    toast.dataset.type = type;
    toast.classList.add('svs-toast-visible');

    toastTimer = window.setTimeout(() => {
      if (toast) {
        toast.classList.remove('svs-toast-visible');
      }
    }, 2800);
  }

  function handleKeyDown(e) {
    if (!e.ctrlKey || !e.shiftKey) {
      return;
    }

    const key = e.key.toLowerCase();
    let handled = false;

    if (key === 's') {
      toggleBar();
      handled = true;
    } else if (key === 'p') {
      sendSpotifyCommand('playPause', 'Komut gönderiliyor...');
      handled = true;
    } else if (key === 'n') {
      sendSpotifyCommand('next', 'Sonraki parça...');
      handled = true;
    } else if (key === 'b') {
      sendSpotifyCommand('previous', 'Önceki parça...');
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function handleOutsideClick(e) {
    if (!container || container.dataset.open !== 'true') {
      return;
    }
    if (container.contains(e.target) || (trigger && trigger.contains(e.target))) {
      return;
    }
    if (container.dataset.expanded === 'true') {
      container.dataset.expanded = 'false';
      requestAnimationFrame(() => {
        updateMarginTop();
        window.setTimeout(updateMarginTop, 360);
      });
    }
  }

  function togglePin() {
    const pinned = container.dataset.pinned === 'true';
    container.dataset.pinned = pinned ? 'false' : 'true';
    els.pin.textContent = pinned ? '\u{1F4CC}' : '\u{1F4CD}';
    els.pin.title = pinned ? 'Sabitle' : 'Sabitlemeyi kaldır';
    if (!pinned) {
      stopAutoHide();
    } else {
      startAutoHide();
    }
  }

  function openBar() {
    container.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    refreshStatus();
    requestAnimationFrame(() => {
      updateMarginTop();
      window.setTimeout(updateMarginTop, 360);
    });
    startAutoHide();
  }

  function closeBar() {
    container.dataset.open = 'false';
    container.dataset.expanded = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    stopAutoHide();
    resetMarginTop();
  }

  function toggleBar() {
    if (container.dataset.open === 'true') {
      closeBar();
    } else {
      openBar();
    }
  }

  function toggleToolbar() {
    const expanded = container.dataset.expanded === 'true';
    container.dataset.expanded = expanded ? 'false' : 'true';
    requestAnimationFrame(() => {
      updateMarginTop();
      window.setTimeout(updateMarginTop, 360);
    });
  }

  function openModal() {
    const modal = document.getElementById('svs-modal');
    if (modal) {
      modal.classList.add('svs-modal-visible');
    }
  }

  function closeModal() {
    const modal = document.getElementById('svs-modal');
    if (modal) {
      modal.classList.remove('svs-modal-visible');
    }
  }

  function startAutoHide() {
    stopAutoHide();
    if (container.dataset.open !== 'true') {
      return;
    }
    if (container.dataset.pinned === 'true') {
      return;
    }
    if (!currentSettings.autoHide) {
      return;
    }
    const delay = Math.max(1, Math.min(10, Number(currentSettings.autoHideDelay) || 2)) * 1000;
    autoHideTimer = window.setTimeout(() => {
      closeBar();
    }, delay);
  }

  function stopAutoHide() {
    if (autoHideTimer) {
      window.clearTimeout(autoHideTimer);
      autoHideTimer = 0;
    }
  }

  function updateMarginTop() {
    if (container.dataset.open !== 'true') {
      resetMarginTop();
      return;
    }
    const height = container.getBoundingClientRect().height;
    if (document.body) {
      document.body.style.marginTop = `${height}px`;
    }
  }

  function resetMarginTop() {
    if (document.body) {
      document.body.style.marginTop = '';
    }
  }

  function loadSettings() {
    if (!hasStorage()) {
      applySettings(DEFAULT_SETTINGS);
      setStatus('Chrome storage erişimi bulunamadı.', 'error');
      return;
    }

    getStorage()
      .then((items) => {
        currentSettings = normalizeSettings(items);
        applySettings(currentSettings);
      })
      .catch((error) => {
        console.error('[Spotify Video Sync] Ayarlar okunamadı:', error);
        currentSettings = { ...DEFAULT_SETTINGS };
        applySettings(currentSettings);
        setStatus('Ayarlar okunamadı. Varsayılanlar gösteriliyor.', 'error');
      });
  }

  function loadTriggerPosition() {
    if (!hasStorage()) return;
    chrome.storage.sync.get('svsTriggerPos', (result) => {
      const pos = result && result.svsTriggerPos;
      if (pos && typeof pos.right === 'number' && typeof pos.top === 'number') {
        trigger.style.right = `${pos.right}px`;
        trigger.style.top = `${pos.top}px`;
        trigger.style.left = 'auto';
      }
    });
  }

  function saveTriggerPosition() {
    if (!hasStorage() || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const right = Math.round(window.innerWidth - rect.right);
    const top = Math.round(rect.top);
    chrome.storage.sync.set({ svsTriggerPos: { right, top } }, () => {
      void chrome.runtime.lastError;
    });
  }

  function saveSettings(event) {
    if (event) {
      event.preventDefault ? event.preventDefault() : null;
    }

    const playlistUrl = els.playlistUrl.value.trim();
    if (playlistUrl && !isSpotifyPlaylistUrl(playlistUrl)) {
      setStatus("Geçerli bir Spotify playlist URL'si girin.", 'error');
      els.playlistUrl.focus();
      return;
    }

    const settings = {
      playlistUrl,
      maxVolume: sanitizeVolume(els.maxVolume.value),
      pauseSpotifyOnVideo: els.pauseOnVideo.checked,
      autoOpenSpotify: els.autoOpen.checked,
      autoHide: els.autoHide.checked,
      autoHideDelay: sanitizeAutoHideDelay(els.autoHideDelay.value),
      autoShowOnVideo: els.autoShowOnVideo.checked,
    };

    currentSettings = settings;
    applySettings(settings);

    if (!hasStorage()) {
      setStatus('Chrome storage erişimi bulunamadı.', 'error');
      return;
    }

    setStatus('Kaydediliyor...', 'neutral');

    setStorage(toStoragePayload(settings))
      .then(() => {
        notifyBackground(settings);
        setStatus('Ayarlar kaydedildi.', 'success');
      })
      .catch((error) => {
        console.error('[Spotify Video Sync] Ayarlar kaydedilemedi:', error);
        setStatus('Ayarlar kaydedilemedi. Tekrar deneyin.', 'error');
      });
  }

  function applySettings(settings) {
    els.playlistUrl.value = settings.playlistUrl;
    syncVolume(settings.maxVolume, true);
    els.pauseOnVideo.checked = settings.pauseSpotifyOnVideo;
    els.autoOpen.checked = settings.autoOpenSpotify;
    els.autoHide.checked = settings.autoHide;
    els.autoShowOnVideo.checked = settings.autoShowOnVideo;
    const delay = sanitizeAutoHideDelay(settings.autoHideDelay);
    els.autoHideDelay.value = delay;
    els.delayValue.textContent = `${delay}s`;
  }

  function applyVolume() {
    const volume = sanitizeVolume(els.maxVolume.value);
    syncVolume(volume, true);
    currentSettings = {
      ...currentSettings,
      maxVolume: volume,
    };

    if (hasStorage()) {
      setStorage(toStoragePayload(currentSettings)).catch((error) => {
        console.error('[Spotify Video Sync] Ses ayarı saklanamadı:', error);
      });
    }

    sendSpotifyCommand('setVolume', 'Ses uygulanıyor...', { volume });
  }

  function bumpVolume(delta) {
    const nextVolume = sanitizeVolume(sanitizeVolume(els.maxVolume.value) + delta);
    syncVolume(nextVolume, true);
    applyVolume();
  }

  function queueVolumeApply() {
    window.clearTimeout(volumeTimer);
    volumeTimer = window.setTimeout(applyVolume, 450);
  }

  function refreshStatus() {
    sendMessage({ type: 'GET_SPOTIFY_STATUS' })
      .then(updatePlayerState)
      .catch((error) => {
        console.error('[Spotify Video Sync] Spotify durumu okunamadı:', error);
        updatePlayerState({ hasSpotifyTab: false });
      });
  }

  function sendSpotifyCommand(command, message, extra) {
    setControlsDisabled(true);
    setStatus(message, 'neutral');

    return sendMessage({
      type: 'SPOTIFY_COMMAND',
      command,
      ...(extra || {}),
    })
      .then((response) => {
        updatePlayerState(response);
        if (response && response.ok === false) {
          setStatus(response.error || 'Komut uygulanamadı.', 'error');
        } else {
          setStatus('Komut uygulandı.', 'success');
        }
      })
      .catch((error) => {
        console.error('[Spotify Video Sync] Komut gönderilemedi:', error);
        setStatus('Komut gönderilemedi.', 'error');
      })
      .finally(() => {
        setControlsDisabled(false);
      });
  }

  function updatePlayerState(response) {
    const hasSpotifyTab = Boolean(response && response.hasSpotifyTab);
    const status = response && response.status ? response.status : null;
    const anyVideoPlaying = Boolean(response && response.anyVideoPlaying);

    els.videoState.textContent = anyVideoPlaying ? 'Video aktif' : 'Video yok';
    els.videoState.dataset.active = anyVideoPlaying ? 'true' : 'false';

    if (!hasSpotifyTab) {
      els.playPause.textContent = 'Oynat';
      els.trackTitle.textContent = 'Parça bilgisi yok';
      els.trackArtist.textContent = 'Spotify Web’i aç';
      return;
    }

    const isPlaying = Boolean(status && status.isPlaying);
    els.playPause.textContent = isPlaying ? 'Duraklat' : 'Oynat';
    els.trackTitle.textContent = status.trackTitle || 'Parça bilgisi yok';
    els.trackArtist.textContent = status.artist || 'Spotify Web';

    if (Number.isFinite(status.volume)) {
      syncVolume(status.volume, true);
    }
  }

  function normalizeSettings(items) {
    const nested = isPlainObject(items.settings) ? items.settings : {};

    return {
      playlistUrl: firstString(
        nested.playlistUrl,
        items.playlistUrl,
        items.spotifyPlaylistUrl,
        DEFAULT_SETTINGS.playlistUrl,
      ),
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
      autoHide: firstBoolean(
        nested.autoHide,
        items.autoHide,
        DEFAULT_SETTINGS.autoHide,
      ),
      autoHideDelay: sanitizeAutoHideDelay(firstDefined(
        nested.autoHideDelay,
        items.autoHideDelay,
        DEFAULT_SETTINGS.autoHideDelay,
      )),
      autoShowOnVideo: firstBoolean(
        nested.autoShowOnVideo,
        items.autoShowOnVideo,
        DEFAULT_SETTINGS.autoShowOnVideo,
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
      autoHide: settings.autoHide,
      autoHideDelay: settings.autoHideDelay,
      autoShowOnVideo: settings.autoShowOnVideo,
    };
  }

  function syncVolume(value, forceClamp) {
    const volume = forceClamp ? sanitizeVolume(value) : value;
    els.maxVolume.value = volume;
    if (els.volValue) {
      els.volValue.textContent = volume;
    }
  }

  function sanitizeVolume(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) {
      return DEFAULT_SETTINGS.maxVolume;
    }
    return Math.min(100, Math.max(0, number));
  }

  function sanitizeAutoHideDelay(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) {
      return DEFAULT_SETTINGS.autoHideDelay;
    }
    return Math.min(10, Math.max(1, number));
  }

  function isSpotifyPlaylistUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        url.hostname === 'open.spotify.com' &&
        url.pathname.startsWith('/playlist/');
    } catch (error) {
      return false;
    }
  }

  function setControlsDisabled(isDisabled) {
    const buttons = container.querySelectorAll('button, input[type="range"], input[type="url"], input[type="checkbox"]');
    buttons.forEach((el) => {
      if (el.id === 'svs-close' || el.id === 'svs-settings' || el.id === 'svs-pin') {
        return;
      }
      el.disabled = isDisabled;
    });
  }

  function setStatus(message, state) {
    window.clearTimeout(statusTimer);
    els.status.textContent = message;
    els.status.dataset.state = state;

    if (state === 'success') {
      statusTimer = window.setTimeout(() => {
        els.status.textContent = '';
        delete els.status.dataset.state;
      }, 2200);
    }
  }

  function notifyBackground(settings) {
    if (!hasRuntime()) {
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings },
      () => void chrome.runtime.lastError,
    );
  }

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!hasRuntime()) {
        reject(new Error('Chrome runtime erişimi bulunamadı.'));
        return;
      }

      chrome.runtime.sendMessage(payload, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }

        resolve(response || {});
      });
    });
  }

  function getStorage() {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get(null, (items) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve(items || {});
      });
    });
  }

  function setStorage(payload) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set(payload, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function hasStorage() {
    return Boolean(window.chrome && chrome.storage && chrome.storage.sync);
  }

  function hasRuntime() {
    return Boolean(window.chrome && chrome.runtime && chrome.runtime.sendMessage);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

  function makeTriggerDraggable() {
    if (!trigger) return;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startTop = 0;

    trigger.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = trigger.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;

      const onMouseMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!isDragging && Math.abs(dx) + Math.abs(dy) > 3) {
          isDragging = true;
          trigger.style.cursor = 'grabbing';
        }
        if (isDragging) {
          const newRight = Math.max(0, startRight - dx);
          const newTop = Math.max(0, startTop + dy);
          trigger.style.right = `${newRight}px`;
          trigger.style.top = `${newTop}px`;
          trigger.style.left = 'auto';
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        trigger.style.cursor = 'pointer';
        if (isDragging) {
          const rect = trigger.getBoundingClientRect();
          const snapRight = window.innerWidth - rect.right;
          trigger.style.transition = 'right 0.2s ease, top 0.2s ease';
          trigger.style.right = `${Math.round(snapRight)}px`;
          trigger.style.top = `${Math.round(rect.top)}px`;
          window.setTimeout(() => {
            trigger.style.transition = '';
            saveTriggerPosition();
          }, 220);
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    trigger.addEventListener('click', (e) => {
      if (isDragging) {
        e.stopPropagation();
        e.preventDefault();
        isDragging = false;
      } else {
        toggleBar();
      }
    });
  }

  function init() {
    createDOM();
    loadSettings();
    loadTriggerPosition();
    refreshStatus();

    window.addEventListener('resize', () => {
      if (container && container.dataset.open === 'true') {
        updateMarginTop();
      }
    });

    window.setInterval(() => {
      if (container && container.dataset.open === 'true') {
        refreshStatus();
      }
    }, 4000);

    if (container) {
      container.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'max-height' || e.propertyName === 'transform') {
          if (container.dataset.open === 'true') {
            updateMarginTop();
          }
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
