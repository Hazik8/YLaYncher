'use strict';

(() => {
var api = window.api;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  info: null,
  config: null,
  versions: [],
  latest: null,
  installed: [],
  news: [],
  newsLoading: false,
  selectedVersionId: 'latest-release',
  page: 'home',
  filter: 'all',
  search: '',
  visibleCount: 60,
  install: null,
  launchBusy: false,
  launchStatus: null,
  running: null,
  javaList: [],
  pickerOpen: false,
  pickerQuery: '',
  logs: [],
  networkOk: false,
  lastLaunchStage: null,
  microsoftFlow: null,
  mods: [],
  modsLoading: false,
  modsError: '',
};

const accountCache = new Map();
const NICK_SUGGESTIONS = ['Steve', 'Alex', 'Miner', 'Ender', 'Creeper', 'Pixel', 'Sova', 'Nova'];

/* ------------------------------------------------------------------ utils */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatPlaytime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (total < 60) return total > 0 ? 'меньше минуты' : '0 мин';
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return `${hours} ч ${minutes > 0 ? `${minutes} мин` : ''}`.trim();
  return `${minutes} мин`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  if (value >= 1024) return `${Math.round(value / 1024)} КБ`;
  return `${value} Б`;
}

function typeLabel(type) {
  if (type === 'release') return 'Release';
  if (type === 'snapshot') return 'Snapshot';
  if (type === 'fabric') return 'Fabric';
  if (type === 'forge') return 'Forge';
  if (type === 'optifine') return 'OptiFine';
  if (type === 'old_beta') return 'Beta';
  if (type === 'old_alpha') return 'Alpha';
  return type || 'Release';
}

function typeClass(type) {
  if (type === 'snapshot') return 'snapshot';
  if (type === 'old_beta' || type === 'old_alpha') return 'old';
  if (type === 'fabric') return 'fabric';
  if (type === 'forge') return 'forge';
  if (type === 'optifine') return 'optifine';
  return '';
}

function recordType(record) {
  if (!record) return 'release';
  return record.loader && record.loader !== 'vanilla' ? record.loader : record.type || 'release';
}

function loaderTag(type) {
  if (type === 'fabric') return 'tag-violet';
  if (type === 'forge') return 'tag-amber';
  if (type === 'optifine') return 'tag-lime';
  return '';
}

function recordSub(record) {
  if (!record) return '';
  const game = record.gameVersion || record.id;
  if (record.loader === 'fabric') return `Fabric ${record.loaderVersion || ''} · ${game}`;
  if (record.loader === 'forge') return `Forge ${record.loaderVersion || ''} · ${game}`;
  if (record.loader === 'optifine') {
    const version = String(record.loaderVersion || '')
      .replace(/^OptiFine_/i, '')
      .replace(/\.jar$/i, '')
      .replace(new RegExp(`^${String(game).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[_-]?`, 'i'), '');
    return `OptiFine ${version} · ${game}`;
  }
  return `Установлена · ${typeLabel(record.type || 'release')}`;
}

function getAccount() {
  if (!state.config) return null;
  return state.config.accounts.find((account) => account.id === state.config.selectedAccountId) || null;
}

function getSettings() {
  return state.config?.settings || {};
}

function getRecord(id) {
  return state.installed.find((item) => item.id === id) || null;
}

function isKnownVersionId(id) {
  if (!id) return false;
  if (id === 'latest-release' || id === 'latest-snapshot') return true;
  return state.installed.some((item) => item.id === id) || state.versions.some((item) => item.id === id);
}

function resolveSelected() {
  const id = state.selectedVersionId;
  if (!id) return null;

  if (id === 'latest-release' || id === 'latest-snapshot') {
    const target = id === 'latest-release' ? state.latest?.release : state.latest?.snapshot;
    if (!target) return { id, type: 'release', displayName: 'Последний релиз', installed: false };
    const record = getRecord(target);
    const entry = state.versions.find((version) => version.id === target);
    return {
      id: target,
      type: record ? recordType(record) : entry?.type || 'release',
      displayName: record?.displayName || target,
      releaseTime: record?.installedAt || entry?.releaseTime,
      installed: Boolean(record),
      record: record || null,
      sentinel: id,
    };
  }

  const record = getRecord(id);
  if (record) {
    return {
      id,
      type: recordType(record),
      displayName: record.displayName || id,
      releaseTime: record.installedAt,
      installed: true,
      record,
    };
  }

  const entry = state.versions.find((version) => version.id === id);
  return {
    id,
    type: entry?.type || 'release',
    displayName: id,
    releaseTime: entry?.releaseTime,
    installed: false,
    record: null,
  };
}

function setAvatar(img, fallback, name) {
  if (!img) return;
  if (!name) {
    img.classList.remove('loaded');
    img.removeAttribute('src');
    if (fallback) fallback.textContent = '+';
    return;
  }
  if (fallback) fallback.textContent = name.slice(0, 2);
  const url = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/128`;
  if (img.dataset.url === url) return;
  img.dataset.url = url;
  img.classList.remove('loaded');
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => img.classList.remove('loaded');
  img.src = url;
}

function showFatal(error) {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML = `
    <div class="fatal-card">
      <div class="welcome-logo">Y</div>
      <h1>Лаунчер не смог запуститься</h1>
      <p>${escapeHtml(error?.message || error || 'Неизвестная ошибка')}</p>
      <p style="font-size:10px;opacity:.6">Попробуйте перезапустить приложение. Если ошибка повторяется — удалите config.json в папке данных лаунчера.</p>
    </div>`;
  document.body.appendChild(box);
}

/* ------------------------------------------------------------------ toasts */
function toast(title, message = '', type = 'success', timeout = 5200) {
  const root = $('#toast-root');
  if (!root) return;
  const icons = { success: 'i-check', error: 'i-warning', info: 'i-sparkles' };
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `
    <span class="toast-icon"><svg><use href="#${icons[type] || icons.success}"/></svg></span>
    <div class="toast-content">
      <strong>${escapeHtml(title)}</strong>
      ${message ? `<span>${escapeHtml(message)}</span>` : ''}
    </div>
    <button class="toast-close" aria-label="Закрыть">×</button>`;
  root.appendChild(element);
  const close = () => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 220);
  };
  $('.toast-close', element).addEventListener('click', close);
  if (timeout > 0) setTimeout(close, timeout);
}

/* ------------------------------------------------------------------ modal */
function closeModal() {
  const overlay = $('.modal-overlay');
  if (overlay) {
    const onClose = overlay.__onClose;
    overlay.__onClose = null;
    if (typeof onClose === 'function') {
      try {
        onClose();
      } catch {
        // Never let modal cleanup break the UI.
      }
    }
    overlay.style.animation = 'fadeIn .15s reverse';
    setTimeout(() => overlay.remove(), 120);
  }
}

function openModal(html, { className = '', onMount, onClose } = {}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ${className}">${html}</div>`;
  overlay.__onClose = onClose;
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeModal();
  });
  $('#modal-root').appendChild(overlay);
  const closeBtn = $('.modal-close', overlay);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (onMount) onMount(overlay);
  return overlay;
}

function openConfirm({ title, text, confirmLabel = 'Подтвердить', danger = true, onConfirm }) {
  const overlay = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>Действие можно отменить только до подтверждения.</p>
      </div>
      <button class="modal-close"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="confirm-body">${text}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-confirm="no">Отмена</button>
        <button class="btn ${danger ? 'btn-primary' : 'btn-primary'}" data-confirm="yes">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`,
  );
  $('[data-confirm="no"]', overlay).addEventListener('click', closeModal);
  $('[data-confirm="yes"]', overlay).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Подождите…';
    try {
      await onConfirm();
      closeModal();
    } catch (error) {
      toast('Не получилось', error.message, 'error');
      button.disabled = false;
      button.textContent = confirmLabel;
    }
  });
}

/* ------------------------------------------------------------------ accounts */
function randomNick() {
  const base = NICK_SUGGESTIONS[Math.floor(Math.random() * NICK_SUGGESTIONS.length)];
  return `${base}${Math.floor(10 + Math.random() * 90)}`;
}

function microsoftLoginMarkup() {
  return `
    <button class="ms-login-btn" id="account-microsoft" type="button">
      <span class="ms-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="ms-login-copy">
        <strong>Войти через Microsoft</strong>
        <small>Лицензионный аккаунт · скины и официальные серверы</small>
      </span>
      <svg class="ms-arrow"><use href="#i-chevron"/></svg>
    </button>`;
}

async function startMicrosoftLogin(button = null) {
  if (state.microsoftFlow) return;
  if (button) {
    button.disabled = true;
    const title = $('.ms-login-copy strong', button);
    if (title) title.textContent = 'Подключаем Microsoft…';
  }
  try {
    const result = await api.microsoftStart();
    if (!result?.ok) throw new Error(result?.error || 'Не удалось начать вход через Microsoft');
    state.microsoftFlow = result;
    openMicrosoftDeviceModal(result);
  } catch (error) {
    if (button) {
      button.disabled = false;
      const title = $('.ms-login-copy strong', button);
      if (title) title.textContent = 'Войти через Microsoft';
    }
    toast('Microsoft недоступен', error.message, 'error', 7000);
  }
}

function openMicrosoftDeviceModal(flow) {
  const minutes = Math.max(1, Math.round((Number(flow.expiresIn) || 900) / 60));
  const overlay = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>Вход через Microsoft</h2>
        <p>Код действует ${minutes} мин. Браузер откроется автоматически.</p>
      </div>
      <button class="modal-close"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="ms-device-head">
        <span class="ms-mark large" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <div>
          <strong>Подтвердите вход</strong>
          <small>Откройте страницу Microsoft и введите этот код</small>
        </div>
      </div>
      <div class="ms-code-row">
        <code id="ms-code">${escapeHtml(flow.userCode)}</code>
        <button class="btn btn-ghost btn-sm" id="ms-copy" type="button">Копировать</button>
      </div>
      <button class="btn btn-primary ms-open" id="ms-open" type="button">
        Открыть страницу Microsoft
      </button>
      <div class="ms-status" id="ms-status">
        <span class="ms-spinner"></span>
        <span id="ms-status-text">Ожидаем подтверждение в браузере…</span>
      </div>
      <p class="error-text" id="ms-error"></p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="ms-cancel" type="button">Отмена</button>
        <button class="btn btn-primary" id="ms-retry" type="button" hidden>Попробовать снова</button>
      </div>
    </div>`,
    {
      className: 'ms-modal',
      onClose() {
        if (state.microsoftFlow?.flowId === flow.flowId) {
          const id = state.microsoftFlow.flowId;
          state.microsoftFlow = null;
          api.microsoftCancel(id).catch(() => {});
          setTimeout(
            () => openAccountModal({ welcome: !(state.config?.accounts || []).length }),
            160,
          );
        }
      },
      onMount(root) {
        const copyButton = $('#ms-copy', root);
        copyButton.addEventListener('click', async () => {
          try {
            await api.writeClipboard(flow.userCode);
          } catch {
            try {
              await navigator.clipboard.writeText(flow.userCode);
            } catch {
              // Clipboard may be unavailable on some Linux setups.
            }
          }
          copyButton.textContent = 'Скопировано';
          setTimeout(() => {
            copyButton.textContent = 'Копировать';
          }, 1600);
        });

        $('#ms-open', root).addEventListener('click', () => {
          api.openExternal(flow.verificationUri).catch(() => {});
        });

        const cancel = () => {
          const id = flow.flowId;
          if (state.microsoftFlow?.flowId === id) state.microsoftFlow = null;
          closeModal();
          api.microsoftCancel(id).catch(() => {});
          setTimeout(
            () => openAccountModal({ welcome: !(state.config?.accounts || []).length }),
            160,
          );
        };
        $('#ms-cancel', root).addEventListener('click', cancel);
        $('#ms-retry', root).addEventListener('click', () => {
          const id = flow.flowId;
          if (state.microsoftFlow?.flowId === id) state.microsoftFlow = null;
          closeModal();
          api.microsoftCancel(id).catch(() => {});
          setTimeout(() => openAccountModal(), 160);
        });
      },
    },
  );
  return overlay;
}

function openAccountModal({ welcome = false } = {}) {
  const accounts = state.config?.accounts || [];
  const selectedId = state.config?.selectedAccountId;
  const accountItems = accounts
    .map((account) => {
      const kind =
        account.type === 'microsoft'
          ? account.hasMicrosoftAuth
            ? 'Microsoft'
            : 'Microsoft · требуется вход'
          : 'Офлайн';
      return `
      <div class="account-list-item ${account.id === selectedId ? 'active' : ''}" data-account-id="${account.id}">
        <span class="avatar-wrap"><img data-avatar="${escapeHtml(account.name)}" alt="" /><span class="avatar-fallback">${escapeHtml(
          account.name.slice(0, 2),
        )}</span></span>
        <span class="account-list-info"><strong>${escapeHtml(account.name)}</strong><small>${kind} · ${escapeHtml(
          account.uuid.slice(0, 8),
        )}…</small></span>
        <span class="account-list-check">${account.id === selectedId ? '<svg><use href="#i-check"/></svg>' : ''}</span>
        <button class="icon-mini danger" data-remove-account="${account.id}" title="Удалить">
          <svg><use href="#i-trash"/></svg>
        </button>
      </div>`;
    })
    .join('');

  const overlay = openModal(
    welcome
      ? `
      <div class="modal-body">
        <div class="welcome-logo">Y</div>
        <div class="modal-head">
          <h2>Добро пожаловать!</h2>
        </div>
        <p class="welcome-lead">Это Y LaYncher — быстрый и уютный лаунчер. Войдите через Microsoft или придумайте офлайн-ник.</p>
        ${microsoftLoginMarkup()}
        <div class="auth-or"><span>или офлайн-аккаунт</span></div>
        <div class="input-group">
          <label for="account-nick">Ваш ник</label>
          <input id="account-nick" type="text" maxlength="16" placeholder="Steve" autocomplete="off" value="${escapeHtml(
            randomNick(),
          )}" />
          <div class="suggest-row">${NICK_SUGGESTIONS.slice(0, 5)
            .map((name) => `<button data-suggest="${name}">${name}</button>`)
            .join('')}<button data-suggest-random>Случайный</button></div>
          <p class="error-text" id="account-error"></p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="account-later">Позже</button>
          <button class="btn btn-primary" id="account-submit">Начать</button>
        </div>
      </div>`
      : `
      <div class="modal-head">
        <div>
          <h2>Аккаунты</h2>
          <p>Выберите аккаунт или подключите новый.</p>
        </div>
        <button class="modal-close"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body">
        ${accounts.length ? `<div class="account-list">${accountItems}</div>` : ''}
        ${accounts.length ? '<div class="divider"></div>' : ''}
        <div class="modal-subtitle">Лицензионный аккаунт</div>
        ${microsoftLoginMarkup()}
        <div class="divider"></div>
        <div class="modal-subtitle">Новый офлайн-аккаунт</div>
        <div class="input-group">
          <label for="account-nick">Ник</label>
          <input id="account-nick" type="text" maxlength="16" placeholder="Steve" autocomplete="off" value="${escapeHtml(
            randomNick(),
          )}" />
          <div class="suggest-row">${NICK_SUGGESTIONS.slice(0, 4)
            .map((name) => `<button data-suggest="${name}">${name}</button>`)
            .join('')}<button data-suggest-random>Случайный</button></div>
          <p class="error-text" id="account-error"></p>
        </div>
        <div class="avatar-preview">
          <span class="avatar-wrap"><img id="account-avatar-preview" alt="" /><span class="avatar-fallback">?</span></span>
          <div class="avatar-preview-meta">
            <strong id="account-preview-name">Steve</strong>
            <small>Аватар подтянется автоматически по нику</small>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="account-cancel">Отмена</button>
          <button class="btn btn-primary" id="account-submit">Добавить аккаунт</button>
        </div>
      </div>`,
    {
      className: welcome ? 'welcome-modal' : '',
      onMount(root) {
        const input = $('#account-nick', root);
        const error = $('#account-error', root);
        const previewName = $('#account-preview-name', root);
        const previewImg = $('#account-avatar-preview', root);
        const previewFallback = previewImg ? previewImg.nextElementSibling : null;

        const updatePreview = () => {
          const value = input.value.trim();
          if (previewName) previewName.textContent = value || 'Steve';
          if (previewImg) setAvatar(previewImg, previewFallback, value || 'Steve');
        };

        updatePreview();
        setTimeout(() => {
          input.focus();
          input.select();
        }, 60);

        input.addEventListener('input', () => {
          input.value = input.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
          error.textContent = '';
          updatePreview();
        });
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') submit();
        });

        $$('[data-suggest]', root).forEach((button) =>
          button.addEventListener('click', () => {
            input.value = button.dataset.suggest;
            updatePreview();
            input.focus();
          }),
        );
        const randomBtn = $('[data-suggest-random]', root);
        if (randomBtn) {
          randomBtn.addEventListener('click', () => {
            input.value = randomNick();
            updatePreview();
          });
        }

        $$('[data-avatar]', root).forEach((img) => {
          const fallback = img.nextElementSibling;
          setAvatar(img, fallback, img.dataset.avatar);
        });

        $('#account-microsoft', root)?.addEventListener('click', (event) =>
          startMicrosoftLogin(event.currentTarget),
        );

        $$('.account-list-item', root).forEach((item) => {
          item.addEventListener('click', async (event) => {
            if (event.target.closest('[data-remove-account]')) return;
            try {
              const result = await api.selectAccount(item.dataset.accountId);
              state.config = result.config;
              renderAccount();
              closeModal();
              toast('Аккаунт выбран', getAccount()?.name || '');
            } catch (err) {
              toast('Ошибка', err.message, 'error');
            }
          });
        });

        $$('[data-remove-account]', root).forEach((button) => {
          button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const id = button.dataset.removeAccount;
            try {
              const result = await api.removeAccount(id);
              state.config = result.config;
              renderAccount();
              closeModal();
              openAccountModal();
              toast('Аккаунт удалён');
            } catch (err) {
              toast('Ошибка', err.message, 'error');
            }
          });
        });

        const submit = async () => {
          const name = input.value.trim();
          if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
            error.textContent = 'Ник: 3–16 символов, только латиница, цифры и _';
            return;
          }
          const submitBtn = $('#account-submit', root);
          submitBtn.disabled = true;
          submitBtn.textContent = 'Добавляем…';
          try {
            const result = await api.addAccount(name);
            state.config = result.config;
            closeModal();
            renderAccount();
            renderHome();
            toast('Аккаунт добавлен', name);
          } catch (err) {
            error.textContent = err.message;
            submitBtn.disabled = false;
            submitBtn.textContent = welcome ? 'Начать' : 'Добавить аккаунт';
          }
        };

        $('#account-submit', root).addEventListener('click', submit);
        const later = $('#account-later', root);
        if (later) later.addEventListener('click', closeModal);
        const cancel = $('#account-cancel', root);
        if (cancel) cancel.addEventListener('click', closeModal);
      },
    },
  );
  return overlay;
}

/* ------------------------------------------------------------------ rendering */
function renderAccount() {
  const account = getAccount();
  const name = account?.name || '';
  const label = name || 'Добавить аккаунт';
  const isMicrosoft = account?.type === 'microsoft';
  const msNeedsLogin = isMicrosoft && !account?.hasMicrosoftAuth;

  $('#sidebar-name').textContent = label;
  $('#sidebar-type').textContent = name
    ? isMicrosoft
      ? msNeedsLogin
        ? 'Требуется вход Microsoft'
        : 'Microsoft-аккаунт'
      : 'Офлайн-аккаунт'
    : 'Нажмите, чтобы войти';
  $('#hello-name').textContent = name || 'игрок';
  setAvatar($('#sidebar-avatar'), $('#sidebar-initials'), name);

  $('#settings-account-name').textContent = name || 'Аккаунт не добавлен';
  $('#settings-account-uuid').textContent = name
    ? `${isMicrosoft ? 'Microsoft ID' : 'UUID'} · ${account.uuid}`
    : 'Подключите Microsoft или добавьте офлайн-ник';
  const badge = $('#settings-account-badge');
  badge.textContent = name ? (isMicrosoft ? (msNeedsLogin ? 'Войти' : 'Microsoft') : 'Offline') : 'Нет';
  badge.className = `tag ${isMicrosoft ? 'tag-violet' : 'tag-lime'}`;
  setAvatar($('#settings-avatar'), $('#settings-initials'), name);

  const hint = $('#settings-account-hint');
  if (hint) {
    hint.textContent = isMicrosoft
      ? msNeedsLogin
        ? 'Сессия Microsoft не найдена. Откройте управление аккаунтом и войдите через Microsoft ещё раз.'
        : 'Лицензионный аккаунт: доступны официальные серверы, скины и достижения. Сессия продлевается автоматически.'
      : 'Офлайн-аккаунт подходит для одиночной игры и серверов без проверки лицензии. Ник можно сменить в любой момент.';
  }

  $('#chip-account').textContent = name || 'нет аккаунта';
  updatePlayUI();
}

function renderHome() {
  const selected = resolveSelected();
  const settings = getSettings();
  const account = getAccount();

  if (selected) {
    $('#picker-version').textContent = selected.displayName || selected.id;
    let sub;
    if (selected.installed) {
      sub = recordSub(selected.record);
    } else {
      sub = `${typeLabel(selected.type)} · ${formatDate(selected.releaseTime)}`;
    }
    $('#picker-sub').textContent = sub;
    const heroType = $('#hero-type');
    heroType.textContent = typeLabel(selected.type);
    heroType.className = `tag ${
      selected.type === 'snapshot' ? 'tag-violet' : loaderTag(selected.type) || (selected.type === 'old_beta' || selected.type === 'old_alpha' ? 'tag-amber' : '')
    }`;
    $('#stat-selected').textContent = selected.displayName || selected.id;

    const record = selected.record;
    $('#chip-mods').textContent = `${record?.mods || 0} модов`;
  }

  const stats = state.config?.stats || {};
  $('#stat-playtime').textContent = formatPlaytime(stats.totalSeconds || 0);
  $('#stat-last-played').textContent = stats.lastPlayed
    ? `Последний запуск ${formatDate(stats.lastPlayed)}`
    : 'Ещё не играли';

  const installedCount = state.installed.length;
  $('#stat-installed').innerHTML = `${installedCount} <small>версий</small>`;
  $('#nav-installed').textContent = installedCount;
  $('#installed-count').textContent = installedCount;

  const selectedRecord = selected?.record;
  $('#chip-mods').textContent = `${selectedRecord?.mods || 0} модов`;

  const memGb = (Number(settings.memoryMax) || 4096) / 1024;
  $('#chip-ram').textContent = `${memGb % 1 === 0 ? memGb : memGb.toFixed(1)} ГБ`;

  const manualJava = state.javaList.find((item) => item.path === settings.javaPath || item.javaPath === settings.javaPath);
  const autoJava = state.javaList[0];
  if (settings.javaPath && manualJava) $('#chip-java').textContent = `Java ${manualJava.major}`;
  else if (settings.javaPath) $('#chip-java').textContent = 'Java: вручную';
  else if (autoJava) $('#chip-java').textContent = `Java ${autoJava.major}`;
  else $('#chip-java').textContent = 'Java: авто';

  if (!account) $('#chip-account').textContent = 'нет аккаунта';

  const latestChip = $('.chip-1');
  if (latestChip && state.latest?.release) latestChip.textContent = state.latest.release;

  updatePlayUI();
  updateProgressUI();
  updateConsoleStatus();
}

function pickerItem(record) {
  return {
    id: record.id,
    label: record.displayName || record.id,
    sub: recordSub(record),
    type: recordType(record),
    installed: true,
  };
}

function pickerVersion(version) {
  return {
    id: version.id,
    label: version.id,
    sub: `${typeLabel(version.type)} · ${formatDate(version.releaseTime)}`,
    type: version.type,
    installed: false,
  };
}

function renderPicker() {
  const menu = $('#picker-menu');
  if (!menu) return;
  const list = $('#picker-list');
  const query = state.pickerQuery.trim().toLowerCase();
  const installedIds = new Set(state.installed.map((item) => item.id));
  const installedItems = state.installed.map(pickerItem);
  const availableVersions = state.versions
    .filter((version) => !installedIds.has(version.id))
    .map(pickerVersion);
  const items = [];

  if (!query) {
    items.push({
      id: 'latest-release',
      label: 'Последний релиз',
      sub: state.latest?.release ? `Автоматически · ${state.latest.release}` : 'Автоматический выбор',
      type: 'release',
      installed: false,
      sentinel: true,
    });

    if (installedItems.length) {
      items.push({ group: `Скачанные · ${installedItems.length}` });
      items.push(...installedItems);
    }

    const suggestions = availableVersions.filter((item) => item.type === 'release').slice(0, 12);
    if (suggestions.length) {
      items.push({ group: 'Доступные для установки' });
      items.push(...suggestions);
    }
  } else {
    const pool = [...installedItems, ...availableVersions];
    for (const item of pool) {
      if (item.id.toLowerCase().includes(query) || item.label.toLowerCase().includes(query)) {
        items.push(item);
        if (items.length >= 80) break;
      }
    }
  }

  const selectedId = state.selectedVersionId === 'latest-release' ? state.latest?.release : state.selectedVersionId;

  if (!items.length) {
    list.innerHTML = '<div class="picker-empty">Ничего не найдено</div>';
    return;
  }

  list.innerHTML = items
    .map((item) => {
      if (item.group) return `<div class="picker-group">${escapeHtml(item.group)}</div>`;
      return `
      <button class="picker-item ${item.sentinel && state.selectedVersionId === 'latest-release' ? 'active' : ''} ${
        item.id === selectedId && state.selectedVersionId !== 'latest-release' ? 'active' : ''
      }" data-select-version="${escapeHtml(item.id)}">
        <span class="picker-item-dot ${typeClass(item.type)}"></span>
        <span class="picker-item-info">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.sub)}</small>
        </span>
        ${item.installed ? '<span class="picker-item-badge">есть</span>' : ''}
      </button>`;
    })
    .join('');

  const active = list.querySelector('.picker-item.active');
  if (active) {
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < listRect.top) list.scrollTop -= listRect.top - activeRect.top;
    else if (activeRect.bottom > listRect.bottom) list.scrollTop += activeRect.bottom - listRect.bottom;
  }
}

function renderVersionsPage() {
  const installed = state.installed || [];
  $('#installed-count').textContent = installed.length;
  $('#nav-installed').textContent = installed.length;

  const search = state.search.trim().toLowerCase();
  const visibleInstalled = installed.filter(
    (record) =>
      !search ||
      record.id.toLowerCase().includes(search) ||
      (record.displayName || '').toLowerCase().includes(search),
  );

  const installedGrid = $('#installed-grid');
  if (!visibleInstalled.length) {
    installedGrid.innerHTML = `
      <div class="installed-empty">
        <svg><use href="#i-cube"/></svg>
        <span>${search ? 'Среди установленных ничего не найдено.' : 'Пока ничего не установлено. Выберите версию ниже — установка займёт пару минут.'}</span>
      </div>`;
  } else {
    installedGrid.innerHTML = visibleInstalled
      .map((record) => {
        const type = recordType(record);
        const letter =
          record.loader === 'fabric' ? 'F' : record.loader === 'forge' ? 'F' : record.loader === 'optifine' ? 'O' : '';
        return `
        <article class="installed-card">
          <span class="version-avatar ${typeClass(type)}">
            ${letter || '<svg><use href="#i-cube"/></svg>'}
          </span>
          <div class="installed-info">
            <strong>${escapeHtml(record.displayName || record.id)}</strong>
            <small>${escapeHtml(recordSub(record))}${record.mods ? ` · ${record.mods} мод.` : ''}</small>
          </div>
          <div class="installed-actions">
            <button class="play-mini" data-action="play-version" data-version="${escapeHtml(record.id)}">
              <svg><use href="#i-play"/></svg> Играть
            </button>
            <button class="icon-mini" data-action="open-version-folder" data-version="${escapeHtml(record.id)}" title="Открыть папку версии">
              <svg><use href="#i-folder"/></svg>
            </button>
            <button class="icon-mini danger" data-action="delete-version" data-version="${escapeHtml(record.id)}" title="Удалить версию">
              <svg><use href="#i-trash"/></svg>
            </button>
          </div>
        </article>`;
      })
      .join('');
  }

  const installedSection = $('#installed-section');
  const allSection = $('#versions-list').closest('.section');
  if (state.filter === 'release' || state.filter === 'snapshot') {
    installedSection.style.display = 'none';
    allSection.style.display = 'block';
  } else if (state.filter === 'installed') {
    installedSection.style.display = 'block';
    allSection.style.display = 'none';
  } else {
    installedSection.style.display = 'block';
    allSection.style.display = 'block';
  }

  let versions = state.versions;
  if (state.filter === 'release' || state.filter === 'snapshot') {
    versions = versions.filter((version) => version.type === state.filter);
  }
  if (state.filter === 'installed') {
    versions = [];
  }
  if (search) {
    versions = versions.filter((version) => version.id.toLowerCase().includes(search));
  }

  $('#versions-count').textContent =
    state.filter === 'installed' ? visibleInstalled.length : versions.length;
  $('#versions-hint').textContent =
    state.filter === 'installed'
      ? `${state.installed.length} установленных сборок`
      : state.versions.length
        ? `${state.versions.length} версий от Mojang · свежие сверху`
        : 'Не удалось загрузить список';

  const list = $('#versions-list');
  if (!versions.length) {
    list.innerHTML = `<div class="version-empty">${search ? 'Версия не найдена' : 'Список пуст'}</div>`;
    $('#load-more').hidden = true;
    return;
  }

  const visible = versions.slice(0, state.visibleCount);
  list.innerHTML = visible
    .map((version) => {
      const record = getRecord(version.id);
      const installedLabel = record ? typeLabel(recordType(record)) : '';
      const installing = state.install && state.install.versionId === version.id;
      return `
      <div class="version-row">
        <div class="version-main">
          <span class="version-avatar ${typeClass(version.type)}"><svg><use href="#i-cube"/></svg></span>
          <span class="version-name">
            <strong>${escapeHtml(version.id)} ${record ? '<span class="version-badge">установлена</span>' : ''}</strong>
            <small>${typeLabel(version.type)}</small>
          </span>
        </div>
        <span class="version-date">${formatDate(version.releaseTime)}</span>
        <span class="version-status ${record ? 'installed' : ''}">
          <span class="version-status-dot"></span>${record ? (installedLabel === 'Release' ? 'Установлена' : installedLabel) : 'Не установлена'}
        </span>
        <div class="version-actions">
          ${
            record
              ? `<button class="btn btn-ghost" data-action="play-version" data-version="${escapeHtml(version.id)}">
                   <svg><use href="#i-play"/></svg> Играть
                 </button>`
              : `<button class="btn btn-primary" data-action="install-version" data-version="${escapeHtml(version.id)}" ${
                  installing ? 'disabled' : ''
                }>
                   <svg><use href="#i-download"/></svg> ${installing ? 'Установка…' : 'Установить'}
                 </button>`
          }
          ${
            record
              ? `<button class="icon-mini" data-action="open-version-folder" data-version="${escapeHtml(version.id)}" title="Папка версии">
                   <svg><use href="#i-folder"/></svg>
                 </button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');

  $('#load-more').hidden = visible.length >= versions.length;
}

function renderNews() {
  const grid = $('#news-grid');
  if (!grid) return;
  if (state.newsLoading) {
    grid.innerHTML = '<div class="news-skeleton"></div><div class="news-skeleton"></div><div class="news-skeleton"></div>';
    return;
  }
  if (!state.news.length) {
    grid.innerHTML = `
      <div class="installed-empty" style="grid-column:1/-1">
        <svg><use href="#i-globe"/></svg>
        <span>Не удалось загрузить новости. Проверьте подключение к интернету и нажмите «Обновить».</span>
      </div>`;
    return;
  }
  grid.innerHTML = state.news
    .slice(0, 6)
    .map(
      (item) => `
      <button class="news-card" data-news-link="${escapeHtml(item.link)}">
        ${item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy" />` : ''}
        <div class="news-body">
          <span class="news-tag">${escapeHtml(item.tag || 'Minecraft')}</span>
          <h4 class="news-title">${escapeHtml(item.title)}</h4>
          <div class="news-meta">${formatDate(item.date)}${item.category ? ` · ${escapeHtml(item.category)}` : ''}</div>
        </div>
      </button>`,
    )
    .join('');
}

function renderSettings() {
  const settings = getSettings();
  const info = state.info || {};
  const totalMemGb = Math.max(4, Math.round((info.totalMemMb || 8192) / 1024));
  const maxMem = Math.min(32768, Math.max(4096, totalMemGb * 1024));

  const memRange = $('#mem-range');
  memRange.max = String(maxMem);
  memRange.value = String(Math.min(settings.memoryMax || 4096, maxMem));
  updateMemRange();

  $('#width-input').value = settings.width || 1280;
  $('#height-input').value = settings.height || 720;
  $('#fullscreen-toggle').checked = Boolean(settings.fullscreen);
  $('#close-launch-toggle').checked = Boolean(settings.closeOnLaunch);
  $('#console-setting-toggle').checked = Boolean(settings.showConsole);
  $('#jvm-args').value = settings.jvmArgs || '';
  $('#game-dir-path').textContent = info.gameDir || settings.gameDir || '…';
  $('#game-dir-path').title = info.gameDir || settings.gameDir || '';
  $('#about-version').textContent = `v${info.launcherVersion || '1.0.0'}`;

  const javaSelect = $('#java-select');
  javaSelect.innerHTML =
    '<option value="">Автоматически (рекомендуется)</option>' +
    state.javaList
      .map(
        (java) =>
          `<option value="${escapeHtml(java.path)}">Java ${java.major} · ${escapeHtml(java.version)} · ${
            java.bits || 64
          }-bit</option>`,
      )
      .join('') +
    (settings.javaPath && !state.javaList.some((java) => java.path === settings.javaPath)
      ? `<option value="${escapeHtml(settings.javaPath)}">Текущий путь · ${escapeHtml(settings.javaPath)}</option>`
      : '');
  javaSelect.value = settings.javaPath || '';

  renderAccount();
}

function updateMemRange() {
  const range = $('#mem-range');
  const value = Number(range.value) || 4096;
  const min = Number(range.min) || 1024;
  const max = Number(range.max) || 32768;
  const percent = ((value - min) / Math.max(1, max - min)) * 100;
  range.style.setProperty('--fill', `${Math.max(2, percent)}%`);
  $('#mem-output').textContent = `${(value / 1024).toLocaleString('ru-RU', {
    maximumFractionDigits: 1,
  })} ГБ`;
}

function updatePlayUI() {
  const selected = resolveSelected();
  const play = $('#play-btn');
  const stop = $('#stop-btn');
  const label = $('#play-label');
  const account = getAccount();
  if (!play || !label) return;

  const running = state.running;
  const isSame = running && selected && running.versionId === selected.id;
  const installing = Boolean(state.install);

  play.classList.toggle('loading', state.launchBusy && !installing);
  stop.hidden = !running;
  play.hidden = Boolean(running);
  play.disabled = false;

  if (running) {
    label.textContent = isSame ? 'Игра запущена' : 'Игра уже запущена';
    play.disabled = true;
    play.classList.remove('loading');
  } else if (!account) {
    label.textContent = 'Добавить аккаунт';
  } else if (installing) {
    label.textContent = `Установка ${Math.round(state.install.percent || 0)}%`;
    play.disabled = true;
  } else if (state.launchBusy) {
    label.textContent = 'Запуск…';
    play.disabled = true;
  } else if (selected?.installed) {
    label.textContent = 'Играть';
  } else {
    label.textContent = 'Установить и играть';
  }
}

function updateProgressUI() {
  const source = state.install || (state.launchBusy ? state.launchStatus : null);
  const hero = $('#hero-progress');
  const versionsBar = $('#versions-progress');

  if (!source) {
    if (hero) hero.hidden = true;
    if (versionsBar) versionsBar.hidden = true;
    return;
  }

  const percent = Math.max(0, Math.min(100, Number(source.percent) || 0));
  const stage = source.message || 'Подготовка…';
  const metaParts = [];
  if (source.speed > 0) metaParts.push(`${formatBytes(source.speed)}/с`);
  if (source.totalFiles) metaParts.push(`${source.doneFiles || 0} / ${source.totalFiles} файлов`);
  if (source.totalBytes) metaParts.push(formatBytes(source.totalBytes));

  for (const [root, stageEl, percentEl, fillEl, metaEl] of [
    [hero, $('#hero-progress-stage'), $('#hero-progress-percent'), $('#hero-progress-fill'), $('#hero-progress-meta')],
    [versionsBar, $('#versions-progress-stage'), $('#versions-progress-percent'), $('#versions-progress-fill'), null],
  ]) {
    if (!root) continue;
    root.hidden = false;
    if (stageEl) stageEl.textContent = stage;
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (metaEl) metaEl.textContent = metaParts.join(' · ');
  }
  const cancel = $('#cancel-install');
  if (cancel) cancel.style.display = state.install?.jobId ? 'inline-flex' : 'none';
}

function updateConsoleStatus() {
  const status = $('#console-status');
  if (!status) return;
  if (state.running) status.textContent = 'игра запущена';
  else if (state.install) status.textContent = 'установка…';
  else if (state.launchBusy) status.textContent = 'запуск…';
  else status.textContent = 'готова';
}

function renderAll() {
  renderAccount();
  renderHome();
  renderVersionsPage();
  renderSettings();
}

/* ------------------------------------------------------------------ logs */
function logTimestamp(ms) {
  return new Date(ms || Date.now()).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function logElement(entry) {
  const line = document.createElement('div');
  const source = entry.source || 'game';
  line.className = `log-line ${source}${/error|exception|fatal|crash/i.test(entry.line) ? ' error' : ''}`;
  line.innerHTML = `<span class="log-time">${logTimestamp(entry.at)}</span><span class="log-text"></span>`;
  $('.log-text', line).textContent = entry.line;
  return line;
}

function addLogLine(line, source = 'launcher') {
  const entry = { at: Date.now(), line, source };
  state.logs.push(entry);
  if (state.logs.length > 2000) state.logs = state.logs.slice(-1500);
  const body = $('#console-body');
  if (body && !$('#console-dock').hidden) {
    const empty = $('.console-empty', body);
    if (empty) empty.remove();
    body.appendChild(logElement(entry));
    body.scrollTop = body.scrollHeight;
  }
  updateConsoleStatus();
}

function renderConsole() {
  const body = $('#console-body');
  if (!body) return;
  body.innerHTML = '';
  if (!state.logs.length) {
    body.innerHTML = '<div class="console-empty">Консоль пуста. Здесь появятся логи установки и запуска игры.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of state.logs.slice(-1200)) fragment.appendChild(logElement(entry));
  body.appendChild(fragment);
  body.scrollTop = body.scrollHeight;
}

function openConsole() {
  const dock = $('#console-dock');
  if (!dock) return;
  const wasHidden = dock.hidden;
  dock.hidden = false;
  $('#console-toggle')?.classList.add('active');
  if (wasHidden) renderConsole();
  const body = $('#console-body');
  body.scrollTop = body.scrollHeight;
}

function closeConsole() {
  $('#console-dock').hidden = true;
  $('#console-toggle')?.classList.remove('active');
}

function toggleConsole() {
  if ($('#console-dock').hidden) openConsole();
  else closeConsole();
}

/* ------------------------------------------------------------------ data */
async function refreshConfig() {
  try {
    state.config = await api.getConfig();
    if (!getAccount()) state.selectedVersionId = state.config.settings.selectedVersion || state.selectedVersionId;
  } catch {
    /* ignore */
  }
}

async function loadVersions(force = false, silent = false) {
  const button = $('#refresh-all');
  const versionRefresh = $('#versions-refresh');
  button?.classList.add('spinning');
  versionRefresh?.classList.add('spinning');
  try {
    const data = await api.versions(force);
    state.versions = data.versions || [];
    state.latest = data.latest || null;
    state.installed = data.installed || [];
    state.networkOk = true;
    if (state.config) {
      state.config.stats = data.stats || state.config.stats;
      state.config.settings.selectedVersion = data.selectedVersion || state.config.settings.selectedVersion;
    }
    // A saved selection may point to a version that was deleted or is no
    // longer supported (for example an inherited Forge profile).
    if (!isKnownVersionId(state.selectedVersionId)) {
      state.selectedVersionId = 'latest-release';
      persistSettings({ selectedVersion: 'latest-release' });
    }
    if (state.selectedVersionId === 'latest-release' && state.latest?.release) {
      // keep the sentinel; display resolves to the actual latest release
    }
    $('#sys-network').textContent = 'Онлайн';
    $('#sys-network').style.color = '';
    renderHome();
    renderVersionsPage();
  } catch (error) {
    state.networkOk = false;
    $('#sys-network').textContent = 'Нет связи';
    $('#sys-network').style.color = 'var(--red)';
    $('#versions-hint').textContent = 'Не удалось загрузить версии';
    if (!silent) toast('Список версий недоступен', error.message, 'error');
  } finally {
    button?.classList.remove('spinning');
    versionRefresh?.classList.remove('spinning');
  }
}

async function loadNews(force = false) {
  state.newsLoading = true;
  renderNews();
  try {
    state.news = await api.getNews(force);
  } catch {
    state.news = [];
  } finally {
    state.newsLoading = false;
    renderNews();
  }
}

async function detectJava({ silent = false } = {}) {
  const badge = $('#java-badge');
  if (badge) badge.textContent = 'Поиск…';
  try {
    state.javaList = await api.detectJava();
    if (badge) {
      badge.textContent = state.javaList.length ? `${state.javaList.length} найдено` : 'Не найдена';
      badge.className = `tag ${state.javaList.length ? 'tag-lime' : 'tag-amber'}`;
    }
    const best = state.javaList[0];
    $('#sys-java').textContent = best ? `Java ${best.major}` : 'скачаем при запуске';
    if (!silent && state.javaList.length) {
      toast('Java найдена', `Java ${best.major} · ${best.version}`, 'info', 3000);
    } else if (!silent && !state.javaList.length) {
      toast('Java не найдена', 'Лаунчер скачает официальную Java при первом запуске.', 'info', 5000);
    }
    renderSettings();
    renderHome();
  } catch (error) {
    if (badge) badge.textContent = 'Ошибка';
    if (!silent) toast('Не удалось проверить Java', error.message, 'error');
  }
}

/* ------------------------------------------------------------------ actions */
async function persistSettings(patch) {
  state.config.settings = { ...state.config.settings, ...patch };
  try {
    await api.patchSettings(patch);
  } catch (error) {
    toast('Не удалось сохранить настройку', error.message, 'error');
  }
}

let settingsTimer = null;
function persistSettingsDebounced(patch, delay = 350) {
  state.config.settings = { ...state.config.settings, ...patch };
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => persistSettings(patch), delay);
}

function selectVersion(id, { persist = true } = {}) {
  state.selectedVersionId = id;
  state.pickerQuery = '';
  const search = $('#picker-search');
  if (search) search.value = '';
  closePicker();
  renderHome();
  if (persist) persistSettings({ selectedVersion: id });
}

function closePicker() {
  state.pickerOpen = false;
  $('#version-picker')?.classList.remove('open');
  const menu = $('#picker-menu');
  if (menu) menu.hidden = true;
}

function placePicker() {
  const menu = $('#picker-menu');
  const button = $('#picker-btn');
  if (!menu || !button) return;

  const rect = button.getBoundingClientRect();
  const margin = 8;
  const edge = 14;
  const spaceBelow = window.innerHeight - rect.bottom - margin - edge;
  const spaceAbove = rect.top - margin - edge;
  const openUp = spaceBelow < 280 && spaceAbove > spaceBelow;
  const available = Math.max(150, (openUp ? spaceAbove : spaceBelow) - 100);
  const listMax = Math.max(120, Math.min(320, available));

  $('#version-picker')?.classList.toggle('open-up', openUp);
  menu.style.setProperty('--picker-list-max', `${Math.round(listMax)}px`);
}

function togglePicker(force) {
  const open = force ?? !state.pickerOpen;
  state.pickerOpen = open;
  $('#version-picker')?.classList.toggle('open', open);
  const menu = $('#picker-menu');
  if (!menu) return;
  menu.hidden = !open;
  if (open) {
    placePicker();
    renderPicker();
    setTimeout(() => $('#picker-search')?.focus(), 50);
  }
}

async function onPlay() {
  const account = getAccount();
  if (!account) {
    openAccountModal({ welcome: !state.config?.accounts?.length });
    return;
  }
  if (state.install || state.launchBusy || state.running) return;
  const selected = resolveSelected();
  if (!selected) return;
  if (!state.versions.length && !selected.installed) {
    toast('Подождите', 'Список версий ещё загружается.', 'info', 2500);
    return;
  }
  if (selected.id === 'latest-release') return;

  state.launchBusy = true;
  updatePlayUI();
  updateProgressUI();
  if (getSettings().showConsole) openConsole();
  addLogLine(`[Launcher] Подготовка к запуску ${selected.displayName || selected.id}…`, 'launcher');

  try {
    const result = await api.launch(selected.id);
    if (!result.ok) {
      toast('Не удалось запустить игру', result.error, 'error', 7000);
      addLogLine(`[Launcher] Ошибка: ${result.error}`, 'launcher');
      openConsole();
      if (result.authRequired) {
        setTimeout(() => openAccountModal(), 250);
      }
    }
  } catch (error) {
    toast('Ошибка запуска', error.message, 'error', 7000);
    addLogLine(`[Launcher] Ошибка: ${error.message}`, 'launcher');
    openConsole();
  } finally {
    state.launchBusy = false;
    state.launchStatus = null;
    updatePlayUI();
    updateProgressUI();
  }
}

async function startInstall(versionId, loader = 'vanilla', loaderVersion) {
  if (state.install) {
    toast('Установка уже идёт', 'Дождитесь завершения текущей задачи.', 'info');
    return;
  }
  if (state.running) {
    toast('Игра запущена', 'Остановите игру перед установкой.', 'info');
    return;
  }
  try {
    const result = await api.installVersion({ versionId, loader, loaderVersion });
    if (!result.ok) throw new Error('Задача не создана');
    state.install = {
      jobId: result.jobId,
      versionId,
      loader,
      percent: 0,
      stage: 'meta',
      message: 'Подготовка к установке…',
      speed: 0,
    };
    updatePlayUI();
    updateProgressUI();
    if (loader === 'fabric') addLogLine(`[Установка] Fabric ${loaderVersion || ''} для ${versionId}`, 'launcher');
    else if (loader === 'forge') addLogLine(`[Установка] Forge ${loaderVersion || ''} для ${versionId}`, 'launcher');
    else if (loader === 'optifine') addLogLine(`[Установка] OptiFine ${loaderVersion || ''} для ${versionId}`, 'launcher');
    else addLogLine(`[Установка] Minecraft ${versionId}`, 'launcher');
    if (getSettings().showConsole) openConsole();
  } catch (error) {
    toast('Не удалось начать установку', error.message, 'error');
  }
}

function confirmDelete(versionId) {
  const record = getRecord(versionId);
  const name = record?.displayName || versionId;
  openConfirm({
    title: 'Удалить версию?',
    text: `Сборка <strong>${escapeHtml(name)}</strong> будет удалена вместе с нативными библиотеками этой версии. Миры, настройки и папка mods останутся на месте.`,
    confirmLabel: 'Удалить',
    onConfirm: async () => {
      const result = await api.deleteVersion(versionId);
      state.installed = result.installed || state.installed.filter((item) => item.id !== versionId);
      if (state.selectedVersionId === versionId) {
        state.selectedVersionId = 'latest-release';
        persistSettings({ selectedVersion: 'latest-release' });
      }
      renderHome();
      renderVersionsPage();
      renderSettings();
      toast('Версия удалена', name);
    },
  });
}

function openModsModal() {
  const overlay = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>Меню модов</h2>
        <p>Forge и Modrinth — установка и поиск модов для выбранной версии.</p>
      </div>
      <button class="modal-close"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="loader-tabs mods-source-tabs" id="mods-source-tabs">
        <button data-mods-source="forge" class="active">Forge</button>
        <button data-mods-source="modrinth">Modrinth</button>
      </div>

      <div id="mods-source-forge">
        <div class="input-group">
          <label>Модлоадер Forge</label>
          <p class="hint">Установите Forge как отдельный профиль, затем добавляйте моды в папку <strong>mods</strong>.</p>
          <button class="btn btn-primary" id="mods-forge-open">Открыть установку Forge</button>
        </div>
      </div>

      <div id="mods-source-modrinth" class="hidden">
        <div class="input-group">
          <label for="mods-search">Поиск по Modrinth</label>
          <div class="row-gap">
            <input id="mods-search" type="text" placeholder="Название мода…" />
            <button class="btn btn-primary" id="mods-search-btn">Найти</button>
          </div>
        </div>
        <div class="mods-results" id="mods-results"></div>
        <p class="error-text" id="mods-error"></p>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mods-cancel">Отмена</button>
    </div>`,
    {
      onMount(root) {
        const tabs = $$('[data-mods-source]', root);
        const forgeSource = $('#mods-source-forge', root);
        const modrinthSource = $('#mods-source-modrinth', root);
        let currentSource = 'forge';

        const setSource = (source) => {
          currentSource = source;
          tabs.forEach((button) => button.classList.toggle('active', button.dataset.modsSource === source));
          forgeSource.classList.toggle('hidden', source !== 'forge');
          modrinthSource.classList.toggle('hidden', source !== 'modrinth');
        };

        tabs.forEach((button) => {
          button.addEventListener('click', () => setSource(button.dataset.modsSource));
        });

        $('#mods-forge-open', root).addEventListener('click', () => {
          closeModal();
          openLoaderModal('forge');
        });
        $('#mods-cancel', root).addEventListener('click', closeModal);
        $('#mods-search-btn', root).addEventListener('click', () => searchMods(root));

        root.addEventListener('click', async (event) => {
          const installButton = event.target.closest('[data-mod-install]');
          if (!installButton) return;
          const projectId = installButton.dataset.modProject;
          const gameVersion = installButton.dataset.modVersion;
          const loader = installButton.dataset.modLoader;
          if (!projectId) return;
          await installModrinthMod({ projectId, gameVersion, loader });
        });
        root.addEventListener('input', (event) => {
          if (event.target.id === 'mods-search') state.modsQuery = event.target.value;
        });
      },
    },
  );
}

async function searchMods(root) {
  const input = $('#mods-search', root);
  const results = $('#mods-results', root);
  const errorEl = $('#mods-error', root);
  const query = String(input?.value || state.modsQuery || '').trim();
  state.modsQuery = query;
  state.modsLoading = true;
  state.modsError = '';
  results.innerHTML = '<div class="version-empty">Поиск…</div>';

  try {
    const selected = resolveSelected();
    const gameVersion =
      selected && selected.id && selected.id !== 'latest-release' && selected.id !== 'latest-snapshot'
        ? selected.id
        : String(state.latest?.release || '');
    const loader = selected?.record?.loader || (selected?.type && selected.type !== 'release' ? selected.type : 'forge');
    const data = await api.modsSearch({ query, gameVersion, loader, limit: 20 });
    state.mods = data.mods || [];
    results.innerHTML = state.mods.length
      ? state.mods
          .map((mod) => {
            const downloads = Number(mod.downloads || 0).toLocaleString('ru-RU');
            return `
            <article class="mod-card">
              <div class="mod-info">
                <strong>${escapeHtml(mod.title)}</strong>
                <small>${escapeHtml(mod.author || 'Неизвестен')} · ${downloads} скачиваний</small>
                <p>${escapeHtml(mod.description)}</p>
              </div>
              <button class="btn btn-ghost" data-mod-install="1" data-mod-project="${escapeHtml(mod.projectId)}" data-mod-version="${escapeHtml(gameVersion)}" data-mod-loader="${escapeHtml(loader)}">
                <svg><use href="#i-download"/></svg> Установить
              </button>
            </article>`;
          })
          .join('')
      : `<div class="version-empty">Моды не найдены для <strong>${escapeHtml(gameVersion)}</strong>.</div>`;
  } catch (error) {
    state.mods = [];
    results.innerHTML = '';
    state.modsError = error?.message || 'Не удалось выполнить поиск';
    errorEl.textContent = state.modsError;
    toast('Поиск модов не удался', state.modsError, 'error');
  } finally {
    state.modsLoading = false;
  }
}

async function installModrinthMod({ projectId, gameVersion, loader }) {
  state.modsLoading = true;
  state.modsError = '';
  try {
    const result = await api.modsInstall({ projectId, gameVersion, loader, modsDir: getSettings().gameDir });
    toast('Мод установлен', result?.file);
    await loadVersions(true);
  } catch (error) {
    state.modsError = error?.message || 'Не удалось установить мод';
    toast('Не удалось установить мод', state.modsError, 'error');
  } finally {
    state.modsLoading = false;
  }
}

function openLoaderModal(initialLoader = 'fabric') {
  const releases = state.versions.filter((version) => version.type === 'release');
  if (!releases.length) {
    toast('Список версий ещё загружается', 'Попробуйте через пару секунд.', 'info');
    return;
  }
  const preferred = resolveSelected();
  const preferredId =
    preferred && releases.some((version) => version.id === preferred.id)
      ? preferred.id
      : releases[0].id;

  const options = releases
    .slice(0, 160)
    .map(
      (version) =>
        `<option value="${version.id}" ${version.id === preferredId ? 'selected' : ''}>${version.id} · ${formatDate(
          version.releaseTime,
        )}</option>`,
    )
    .join('');

  const overlay = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>Установить модлоадер</h2>
        <p>Fabric, Forge или OptiFine — отдельной сборкой, без изменения ванильной версии.</p>
      </div>
      <button class="modal-close"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="loader-tabs" id="loader-tabs">
        <button data-loader-kind="fabric" class="${initialLoader === 'fabric' ? 'active' : ''}">Fabric</button>
        <button data-loader-kind="forge" class="${initialLoader === 'forge' ? 'active' : ''}">Forge</button>
        <button data-loader-kind="optifine" class="${initialLoader === 'optifine' ? 'active' : ''}">OptiFine</button>
      </div>
      <div class="fabric-form">
        <div class="input-group">
          <label for="loader-game">Версия Minecraft</label>
          <select id="loader-game">${options}</select>
        </div>
        <div class="input-group">
          <label for="loader-build" id="loader-build-label">Версия Fabric Loader</label>
          <select id="loader-build"><option>Загрузка…</option></select>
          <div class="loader-info" id="loader-info"></div>
        </div>
        <div class="fabric-note">
          <svg><use href="#i-sparkles"/></svg>
          <span id="loader-note"></span>
        </div>
        <p class="error-text" id="loader-error"></p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="loader-cancel">Отмена</button>
        <button class="btn btn-primary" id="loader-install" disabled>Установить</button>
      </div>
    </div>`,
    {
      onMount(root) {
        const gameSelect = $('#loader-game', root);
        const buildSelect = $('#loader-build', root);
        const buildLabel = $('#loader-build-label', root);
        const info = $('#loader-info', root);
        const note = $('#loader-note', root);
        const errorEl = $('#loader-error', root);
        const installBtn = $('#loader-install', root);
        const tabs = $$('[data-loader-kind]', root);
        let currentLoader = initialLoader;
        let requestToken = 0;

        const loaderName = () => typeLabel(currentLoader);

        const setInfo = (count, best) => {
          info.innerHTML =
            count && best
              ? `<span class="tag ${loaderTag(currentLoader)}">${loaderName()}</span> <span>${count} сборок · рекомендуется ${escapeHtml(
                  best,
                )}</span>`
              : '';
        };

        const setNote = () => {
          if (currentLoader === 'fabric') {
            note.innerHTML =
              'Fabric ставится отдельной сборкой — ванильная версия останется нетронутой. Моды кладите в папку <strong>mods</strong>.';
          } else if (currentLoader === 'forge') {
            note.innerHTML =
              'Forge использует официальный установщик. После установки появится отдельный профиль с поддержкой модов.';
          } else {
            note.innerHTML =
              'OptiFine устанавливается официальным установщиком в выбранную папку игры. Профиль также появится отдельно.';
          }
        };

        const normalizeBuilds = (items) => {
          if (currentLoader === 'fabric') {
            return items.map((loader) => ({
              value: loader.version,
              label: loader.version,
              note: loader.stable ? 'стабильная' : '',
              best: loader.stable,
            }));
          }
          if (currentLoader === 'forge') {
            return items.map((build) => ({
              value: build.version,
              label: build.version,
              note: build.recommended ? 'рекомендуемая' : build.latest ? 'последняя' : '',
              best: build.recommended,
            }));
          }
          return items.map((build) => ({
            value: build.fileName,
            label: build.label || build.fileName,
            note: [build.preview ? 'preview' : build.old ? 'старая' : '', build.forge !== 'Forge N/A' ? build.forge : '']
              .filter(Boolean)
              .join(' · '),
            best: build.main,
            date: build.date,
          }));
        };

        const loadBuilds = async () => {
          const gameVersion = gameSelect.value;
          const token = ++requestToken;
          buildSelect.innerHTML = '<option>Загрузка…</option>';
          buildSelect.disabled = true;
          installBtn.disabled = true;
          info.innerHTML = '';
          errorEl.textContent = '';
          buildLabel.textContent = `Версия ${loaderName()}`;
          setNote();
          try {
            const builds = normalizeBuilds(await api.loaderBuilds(currentLoader, gameVersion));
            if (token !== requestToken) return;
            if (!builds.length) {
              buildSelect.innerHTML = '<option>Нет доступных сборок</option>';
              errorEl.textContent = `${loaderName()} пока не поддерживает Minecraft ${gameVersion}.`;
              info.innerHTML = `<span class="tag ${loaderTag(currentLoader)}">${loaderName()}</span> <span>Нет сборок для ${escapeHtml(
                gameVersion,
              )}</span>`;
              return;
            }
            buildSelect.innerHTML = builds
              .slice(0, 120)
              .map(
                (build) =>
                  `<option value="${escapeHtml(build.value)}">${escapeHtml(build.label)}${
                    build.note ? ` · ${escapeHtml(build.note)}` : ''
                  }</option>`,
              )
              .join('');
            buildSelect.disabled = false;
            installBtn.disabled = false;
            const best = builds.find((build) => build.best) || builds[0];
            buildSelect.value = best.value;
            setInfo(builds.length, best.label);
          } catch (err) {
            if (token !== requestToken) return;
            buildSelect.innerHTML = '<option>Ошибка загрузки</option>';
            errorEl.textContent = err.message;
          }
        };

        tabs.forEach((button) => {
          button.classList.toggle('active', button.dataset.loaderKind === currentLoader);
          button.addEventListener('click', () => {
            if (currentLoader === button.dataset.loaderKind) return;
            currentLoader = button.dataset.loaderKind;
            tabs.forEach((tab) => tab.classList.toggle('active', tab === button));
            loadBuilds();
          });
        });

        gameSelect.addEventListener('change', loadBuilds);
        loadBuilds();

        $('#loader-cancel', root).addEventListener('click', closeModal);
        installBtn.addEventListener('click', () => {
          const gameVersion = gameSelect.value;
          const loaderVersion = buildSelect.value;
          if (!gameVersion || !loaderVersion) return;
          closeModal();
          startInstall(gameVersion, currentLoader, loaderVersion);
        });
      },
    },
  );
  return overlay;
}

async function handleAction(action, element) {
  const versionId = element.dataset.version;
  switch (action) {
    case 'play':
      onPlay();
      break;
    case 'stop':
      await api.stopGame();
      break;
    case 'play-version':
      if (versionId) {
        selectVersion(versionId);
        await onPlay();
      }
      break;
    case 'install-version':
      if (versionId) startInstall(versionId);
      break;
    case 'delete-version':
      if (versionId) confirmDelete(versionId);
      break;
    case 'open-version-folder':
      if (versionId) await api.openFolder({ kind: 'version', versionId });
      break;
    case 'open-mods':
      await api.openFolder({ kind: 'mods' });
      break;
    case 'open-mods-menu':
      openModsModal();
      break;
    case 'open-game':
      await api.openFolder({ kind: 'game' });
      break;
    case 'open-saves':
      await api.openFolder({ kind: 'saves' });
      break;
    case 'open-logs':
      await api.openFolder({ kind: 'logs' });
      break;
    case 'open-fabric':
    case 'open-loader':
      openLoaderModal('fabric');
      break;
    case 'open-site':
      await api.openExternal('https://www.minecraft.net/');
      break;
    case 'open-eula':
      await api.openExternal('https://www.minecraft.net/en-us/eula');
      break;
    case 'open-data':
      if (state.info?.userData) await api.openPath(state.info.userData);
      break;
    case 'cancel-install':
      if (state.install?.jobId) {
        await api.cancelInstall(state.install.jobId);
        toast('Установка отменяется', 'Завершаем текущий файл…', 'info', 3000);
      }
      break;
    default:
      break;
  }
}

function navigate(page) {
  if (state.page === page) return;
  state.page = page;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page').forEach((section) => section.classList.toggle('active', section.dataset.page === page));
  $('#content').scrollTop = 0;
  if (page === 'versions') {
    loadVersions(false, true).catch(() => {});
  }
}

/* ------------------------------------------------------------------ events */
function bindEvents() {
  // window
  $('#win-minimize').addEventListener('click', () => api.window.minimize());
  $('#win-maximize').addEventListener('click', () => api.window.maximize());
  $('#win-close').addEventListener('click', () => api.window.close());
  api.window.onMaximized((maximized) => {
    const btn = $('#win-maximize');
    if (btn) btn.title = maximized ? 'Восстановить' : 'Развернуть';
  });

  // navigation
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => navigate(item.dataset.page)));

  // console
  $('#console-toggle').addEventListener('click', toggleConsole);
  $('#sidebar-console').addEventListener('click', toggleConsole);
  $('#console-close').addEventListener('click', closeConsole);
  $('#console-clear').addEventListener('click', async () => {
    await api.clearLogs();
    state.logs = [];
    renderConsole();
    toast('Консоль очищена', '', 'info', 2000);
  });
  $('#console-copy').addEventListener('click', async () => {
    const text = state.logs.map((entry) => `${logTimestamp(entry.at)} ${entry.line}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Логи скопированы', `${state.logs.length} строк`, 'info', 2500);
    } catch {
      toast('Не удалось скопировать', 'Буфер обмена недоступен.', 'error');
    }
  });

  // account
  $('#account-card').addEventListener('click', () => openAccountModal());
  $('#settings-account-btn').addEventListener('click', () => openAccountModal());

  // play / stop
  $('#play-btn').addEventListener('click', onPlay);
  $('#stop-btn').addEventListener('click', async () => {
    await api.stopGame();
    toast('Останавливаем игру', 'Процесс завершается…', 'info', 3000);
  });

  // picker
  $('#picker-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    togglePicker();
  });
  $('#picker-search').addEventListener('input', (event) => {
    state.pickerQuery = event.target.value;
    renderPicker();
  });
  $('#picker-all').addEventListener('click', () => {
    closePicker();
    navigate('versions');
  });
  $('#content').addEventListener(
    'scroll',
    () => {
      if (state.pickerOpen) closePicker();
    },
    { passive: true },
  );
  window.addEventListener('resize', () => {
    if (state.pickerOpen) closePicker();
  });
  document.fonts?.ready.then(() => {
    if (state.pickerOpen) placePicker();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#version-picker')) closePicker();
    if (!event.target.closest('#play-btn') && !event.target.closest('#stop-btn')) {
      /* noop */
    }
  });

  // refresh
  $('#refresh-all').addEventListener('click', async () => {
    await Promise.all([loadVersions(true), loadNews(true), detectJava({ silent: true })]);
    toast('Данные обновлены', '', 'info', 2000);
  });
  $('#news-refresh').addEventListener('click', () => loadNews(true));
  $('#versions-refresh').addEventListener('click', () => loadVersions(true));
  $('#open-fabric').addEventListener('click', () => openLoaderModal('fabric'));
  $('#open-mods').addEventListener('click', openModsModal);
  $('#cancel-install').addEventListener('click', () => handleAction('cancel-install', $('#cancel-install')));

  // version filters/search
  $('#version-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    state.visibleCount = 60;
    renderVersionsPage();
  });
  $$('#version-filter button').forEach((button) =>
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      state.visibleCount = 60;
      $$('#version-filter button').forEach((item) => item.classList.toggle('active', item === button));
      renderVersionsPage();
    }),
  );
  $('#load-more').addEventListener('click', () => {
    state.visibleCount += 80;
    renderVersionsPage();
  });

  // settings - memory
  $('#mem-range').addEventListener('input', () => {
    updateMemRange();
    persistSettingsDebounced({ memoryMax: Number($('#mem-range').value) }, 250);
    renderHome();
  });

  // settings - resolution
  $('#width-input').addEventListener('change', (event) => {
    persistSettings({ width: Number(event.target.value) || 1280 });
  });
  $('#height-input').addEventListener('change', (event) => {
    persistSettings({ height: Number(event.target.value) || 720 });
  });
  $$('#resolution-presets button').forEach((button) =>
    button.addEventListener('click', () => {
      const [width, height] = button.dataset.res.split('x').map(Number);
      $('#width-input').value = width;
      $('#height-input').value = height;
      persistSettings({ width, height });
      toast('Разрешение сохранено', `${width}×${height}`, 'info', 2200);
    }),
  );

  // settings - toggles
  $('#fullscreen-toggle').addEventListener('change', (event) => persistSettings({ fullscreen: event.target.checked }));
  $('#close-launch-toggle').addEventListener('change', (event) => persistSettings({ closeOnLaunch: event.target.checked }));
  $('#console-setting-toggle').addEventListener('change', (event) => persistSettings({ showConsole: event.target.checked }));

  $('#jvm-args').addEventListener('input', (event) => persistSettingsDebounced({ jvmArgs: event.target.value }));

  // settings - folder
  $('#browse-game-dir').addEventListener('click', async () => {
    const folder = await api.pickFolder(getSettings().gameDir);
    if (!folder) return;
    persistSettings({ gameDir: folder });
    state.info = await api.info();
    renderSettings();
    loadVersions(true, true);
    toast('Папка игры изменена', folder, 'info');
  });

  // settings - java
  $('#java-detect').addEventListener('click', () => detectJava());
  $('#java-browse').addEventListener('click', async () => {
    const file = await api.pickJava(getSettings().javaPath || undefined);
    if (!file) return;
    persistSettings({ javaPath: file });
    await detectJava({ silent: true });
    renderSettings();
    toast('Java выбрана вручную', file, 'info');
  });
  $('#java-select').addEventListener('change', (event) => {
    persistSettings({ javaPath: event.target.value });
    renderHome();
    toast('Настройка Java сохранена', event.target.value || 'Автоматический выбор', 'info', 2200);
  });

  // dynamic actions
  document.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      event.preventDefault();
      await handleAction(actionEl.dataset.action, actionEl).catch((error) =>
        toast('Ошибка', error.message, 'error'),
      );
      return;
    }
    const versionEl = event.target.closest('[data-select-version]');
    if (versionEl) {
      selectVersion(versionEl.dataset.selectVersion);
      return;
    }
    const newsEl = event.target.closest('[data-news-link]');
    if (newsEl) {
      api.openExternal(newsEl.dataset.newsLink);
    }
  });

  // keyboard
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePicker();
      closeModal();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '`') {
      event.preventDefault();
      toggleConsole();
    }
  });

  // backend events
  api.onInstallProgress((payload) => {
    const previousStage = state.install?.stage;
    state.install = {
      ...(state.install || {}),
      ...payload,
    };
    if (previousStage !== payload.stage) {
      addLogLine(`[Установка] ${payload.message}`, 'launcher');
    }
    if (payload.stage === 'done') {
      state.install = null;
    }
    updatePlayUI();
    updateProgressUI();
    updateConsoleStatus();
    if (state.page === 'versions') renderVersionsPage();
  });

  api.onInstallDone((payload) => {
    state.install = null;
    state.installed = payload.installed || state.installed;
    addLogLine(`[Установка] ${payload.record?.displayName || payload.versionId} установлена`, 'launcher');
    if (payload.record) {
      selectVersion(payload.record.id);
    }
    toast('Установка завершена', payload.record?.displayName || payload.versionId);
    updatePlayUI();
    updateProgressUI();
    renderHome();
    renderVersionsPage();
  });

  api.onInstallError((payload) => {
    state.install = null;
    updatePlayUI();
    updateProgressUI();
    if (payload.cancelled) {
      addLogLine('[Установка] Отменена пользователем', 'launcher');
      toast('Установка отменена', '', 'info', 3500);
    } else {
      addLogLine(`[Установка] Ошибка: ${payload.error}`, 'launcher');
      toast('Установка не удалась', payload.error, 'error', 7000);
      openConsole();
    }
    renderVersionsPage();
  });

  api.onLaunchStatus((payload) => {
    state.launchStatus = payload;
    const key = `${payload.stage}:${payload.message}`;
    if (state.lastLaunchStage !== key && payload.stage !== 'launch') {
      state.lastLaunchStage = key;
      addLogLine(`[Запуск] ${payload.message}`, 'launcher');
    }
    updateProgressUI();
    updateConsoleStatus();
  });

  api.onGameStarted((payload) => {
    state.running = payload;
    state.launchBusy = false;
    state.install = null;
    state.launchStatus = null;
    state.lastLaunchStage = null;
    addLogLine(`[Launcher] Игра запущена · PID ${payload.pid}`, 'launcher');
    toast('Удачной игры!', `${payload.displayName || payload.versionId} · ${payload.account?.name || ''}`, 'success');
    updatePlayUI();
    updateProgressUI();
    updateConsoleStatus();
    if (state.page === 'home') renderHome();
  });

  api.onGameExit((payload) => {
    state.running = null;
    state.launchBusy = false;
    state.launchStatus = null;
    state.install = null;
    addLogLine(
      `[Launcher] Игра завершена · код ${payload.code} · ${formatPlaytime(payload.seconds)}`,
      'launcher',
    );
    if (payload.stopped) {
      toast('Игра остановлена', '', 'info', 3500);
    } else if (payload.hint) {
      toast('Игра завершилась с ошибкой', payload.hint, 'error', 9000);
      openConsole();
    } else if (payload.code !== 0) {
      toast('Игра закрылась', `Код выхода ${payload.code}. Подробности в консоли.`, 'error', 6000);
      openConsole();
    } else {
      toast('Игра закрыта', `В этот раз — ${formatPlaytime(payload.seconds)}`, 'info', 4000);
    }
    refreshConfig().then(() => {
      renderHome();
      renderSettings();
    });
    updatePlayUI();
    updateProgressUI();
    updateConsoleStatus();
  });

  api.onGameLog((payload) => {
    addLogLine(payload.line, payload.source || 'game');
  });

  api.onMicrosoftStatus((payload) => {
    if (state.microsoftFlow?.flowId !== payload.flowId) return;
    const status = $('#ms-status');
    const text = $('#ms-status-text');
    if (status) status.classList.remove('error');
    if (text && payload.message) text.textContent = payload.message;
  });

  api.onMicrosoftDone((payload) => {
    if (state.microsoftFlow?.flowId !== payload.flowId) return;
    state.microsoftFlow = null;
    if (payload.config) state.config = payload.config;
    closeModal();
    renderAccount();
    renderHome();
    renderSettings();
    toast('Microsoft подключён', payload.account?.name || 'Аккаунт готов к игре');
  });

  api.onMicrosoftError((payload) => {
    if (state.microsoftFlow?.flowId !== payload.flowId) return;
    state.microsoftFlow = null;
    if (payload.cancelled) {
      closeModal();
      return;
    }
    const status = $('#ms-status');
    const text = $('#ms-status-text');
    const error = $('#ms-error');
    const retry = $('#ms-retry');
    if (status) status.classList.add('error');
    if (text) text.textContent = 'Не удалось войти';
    if (error) error.textContent = payload.error || 'Неизвестная ошибка';
    if (retry) retry.hidden = false;
  });
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  if (!api) {
    showFatal(new Error('Мост Electron не инициализирован. Запустите приложение через npm start.'));
    return;
  }
  bindEvents();

  try {
    const [info, config, runningResult, logs] = await Promise.all([
      api.info(),
      api.getConfig(),
      api.running().catch(() => ({ running: null })),
      api.getLogs().catch(() => []),
    ]);
    state.info = info;
    state.config = config;
    state.selectedVersionId = config.settings.selectedVersion || 'latest-release';
    state.running = runningResult?.running || null;
    state.javaList = info.java || [];
    state.logs = Array.isArray(logs) ? logs : [];

    $('#sys-ram').textContent = `${Math.round((info.totalMemMb || 0) / 1024)} ГБ ОЗУ`;
    $('#sys-java').textContent = state.javaList[0] ? `Java ${state.javaList[0].major}` : 'поиск…';
    renderAll();
    renderConsole();
    renderNews();

    if (!config.accounts.length) {
      setTimeout(() => openAccountModal({ welcome: true }), 350);
    }

    loadVersions();
    loadNews();
    detectJava({ silent: true });
  } catch (error) {
    showFatal(error);
  }
}

boot();
})();
