'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, Menu, ipcMain, shell, clipboard } = require('electron');

const { Store } = require('./lib/store');
const { getNews } = require('./lib/news');
const {
  getPaths,
  ensureGameDirs,
  getSystemInfo,
  getJavaCandidates,
  pickFolder,
  pickJavaFile,
  openPath,
  openExternal,
} = require('./lib/system');
const {
  installVersion,
  getVersionList,
  getInstalledRecord,
  deleteVersion,
  getFabricLoaders,
  getFabricInfoForVersion,
  getForgeBuilds,
  getOptiFineBuilds,
} = require('./lib/mojang');
const game = require('./lib/launcher');
const microsoft = require('./lib/microsoft');
const { searchModrinth, installModrinthMod } = require('./lib/mods');

let mainWindow = null;
let store = null;
let isQuitting = false;
const installJobs = new Map();
const microsoftFlows = new Map();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function prepareAccountForLaunch(account, versionId) {
  if (!account || account.type !== 'microsoft') return account;

  const stored = store.getAccount(account.id);
  const auth = store.getAccountAuth(stored);
  try {
    const session = await microsoft.ensureSession({
      auth,
      onStatus: (status) =>
        send('launch:status', {
          versionId,
          percent: 0,
          ...status,
        }),
    });
    store.setAccountAuth(account.id, session.auth);
    if (session.profile) store.updateMicrosoftProfile(account.id, session.profile);
    const refreshed = store.getAccount(account.id);
    return { ...refreshed, auth: session.auth };
  } catch (error) {
    const wrapped = new Error(error?.message || 'Не удалось обновить сессию Microsoft');
    wrapped.code = error?.code || 'AUTH_ERROR';
    wrapped.authRequired = [
      'AUTH_REQUIRED',
      'NO_PROFILE',
      'NOT_OWNED',
      'MINECRAFT_LOGIN',
      'DECLINED',
      'CODE_EXPIRED',
    ].includes(wrapped.code);
    throw wrapped;
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#07080c',
    title: 'Y LaYncher',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('maximize', () => send('window:maximized', true));
  mainWindow.on('unmaximize', () => send('window:maximized', false));
  mainWindow.on('close', (event) => {
    // Keep the process (and the running game) alive when the user closes the
    // window during a session. The window comes back automatically on exit.
    if (!isQuitting && game.isRunning()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] gone:', details);
  });
}

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    const settings = store.getSettings();
    const paths = getPaths(settings.gameDir);
    await ensureGameDirs(paths).catch(() => {});
    return {
      ...(await getSystemInfo(settings)),
      configFile: store.file,
      running: game.runningInfo(),
      paths,
    };
  });

  ipcMain.handle('config:get', () => store.publicConfig());

  ipcMain.handle('settings:patch', (_event, patch) => {
    const next = { ...patch };
    if (next.memoryMax != null) {
      next.memoryMax = Math.max(512, Math.min(65536, Math.round(Number(next.memoryMax) || 4096)));
    }
    if (next.memoryMin != null) {
      next.memoryMin = Math.max(256, Math.min(next.memoryMax || 65536, Math.round(Number(next.memoryMin) || 512)));
    }
    if (next.width != null) next.width = Math.max(640, Math.min(7680, Math.round(Number(next.width) || 1280)));
    if (next.height != null) next.height = Math.max(480, Math.min(4320, Math.round(Number(next.height) || 720)));
    return store.patchSettings(next);
  });

  ipcMain.handle('accounts:add', (_event, { name }) => {
    const account = store.addAccount(name);
    store.selectAccount(account.id);
    return { account: store.publicAccount(account), config: store.publicConfig() };
  });

  ipcMain.handle('accounts:remove', (_event, { id }) => {
    store.removeAccount(id);
    return { config: store.publicConfig() };
  });

  ipcMain.handle('accounts:select', (_event, { id }) => {
    store.selectAccount(id);
    return { config: store.publicConfig() };
  });

  ipcMain.handle('accounts:microsoft-start', async () => {
    for (const flow of microsoftFlows.values()) flow.cancelled = true;
    microsoftFlows.clear();

    const flowId = crypto.randomUUID();
    const flow = { flowId, cancelled: false, createdAt: Date.now() };
    microsoftFlows.set(flowId, flow);

    try {
      const device = await microsoft.startDeviceCode();
      flow.device = device;
      openExternal(device.verificationUri).catch(() => {});
      send('microsoft:status', {
        flowId,
        stage: 'waiting',
        message: 'Ожидаем подтверждение в браузере…',
      });

      (async () => {
        try {
          const tokens = await microsoft.pollDeviceCode({
            deviceCode: device.deviceCode,
            interval: device.interval,
            expiresIn: device.expiresIn,
            isCancelled: () => flow.cancelled,
            onStatus: (status) => send('microsoft:status', { flowId, ...status }),
          });
          const session = await microsoft.loginWithTokens(tokens, {
            onStatus: (status) => {
              if (!flow.cancelled) send('microsoft:status', { flowId, ...status });
            },
          });
          if (flow.cancelled) return;
          const account = store.addMicrosoftAccount(session.profile, session.auth);
          send('microsoft:done', {
            flowId,
            account: store.publicAccount(account),
            config: store.publicConfig(),
          });
        } catch (error) {
          send('microsoft:error', {
            flowId,
            error: error?.message || 'Не удалось войти через Microsoft',
            code: error?.code || 'AUTH_ERROR',
            cancelled: Boolean(error?.cancelled) || flow.cancelled,
          });
        } finally {
          microsoftFlows.delete(flowId);
        }
      })();

      return {
        ok: true,
        flowId,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresIn: device.expiresIn,
        interval: device.interval,
      };
    } catch (error) {
      microsoftFlows.delete(flowId);
      return {
        ok: false,
        error: error?.message || 'Не удалось начать вход через Microsoft',
        code: error?.code || 'AUTH_ERROR',
      };
    }
  });

  ipcMain.handle('accounts:microsoft-cancel', (_event, { flowId } = {}) => {
    const flow = microsoftFlows.get(flowId);
    if (!flow) return { ok: false };
    flow.cancelled = true;
    return { ok: true };
  });

  ipcMain.handle('clipboard:write', (_event, { text } = {}) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('versions:list', async (_event, { force } = {}) => {
    const data = await getVersionList(store.gameDir(), Boolean(force));
    const config = store.get();
    return {
      ...data,
      stats: config.stats,
      selectedVersion: config.settings.selectedVersion,
      latest: data.latest,
    };
  });

  ipcMain.handle('versions:install', async (_event, { versionId, loader = 'vanilla', loaderVersion }) => {
    if (!versionId) throw new Error('Не указана версия');
    const jobId = crypto.randomUUID();
    const job = { cancelled: false, versionId, loader };
    installJobs.set(jobId, job);

    const run = async () => {
      try {
        const record = await installVersion({
          versionId,
          loader,
          loaderVersion,
          gameDir: store.gameDir(),
          onProgress: (progress) =>
            send('install:progress', { jobId, versionId, loader, ...progress }),
          isCancelled: () => job.cancelled,
        });
        const installed = await getVersionList(store.gameDir());
        send('install:done', {
          jobId,
          versionId,
          loader,
          record,
          installed: installed.installed,
        });
      } catch (error) {
        send('install:error', {
          jobId,
          versionId,
          loader,
          error: error?.message || 'Неизвестная ошибка',
          cancelled: Boolean(error?.cancelled),
        });
      } finally {
        installJobs.delete(jobId);
      }
    };

    run();
    return { ok: true, jobId };
  });

  ipcMain.handle('install:cancel', (_event, { jobId }) => {
    const job = installJobs.get(jobId);
    if (!job) return { ok: false, error: 'Задача не найдена' };
    job.cancelled = true;
    return { ok: true };
  });

  ipcMain.handle('versions:delete', async (_event, { versionId }) => {
    if (game.isRunning() && game.runningInfo()?.versionId === versionId) {
      throw new Error('Нельзя удалить версию, пока игра запущена');
    }
    await deleteVersion(versionId, store.gameDir());
    return { installed: await getVersionList(store.gameDir()).then((data) => data.installed) };
  });

  ipcMain.handle('versions:open-folder', async (_event, { kind = 'game', versionId }) => {
    const paths = getPaths(store.gameDir());
    let target = paths.gameDir;
    if (kind === 'mods') target = path.join(paths.gameDir, 'mods');
    else if (kind === 'version' && versionId) target = path.join(paths.versions, versionId);
    else if (kind === 'logs') target = path.join(paths.gameDir, 'logs');
    else if (kind === 'saves') target = path.join(paths.gameDir, 'saves');
    return openPath(target);
  });

  ipcMain.handle('fabric:loaders', async (_event, { gameVersion }) => {
    const loaders = await getFabricLoaders(gameVersion);
    return loaders;
  });

  ipcMain.handle('loader:builds', async (_event, { loader, gameVersion }) => {
    if (!gameVersion) return [];
    if (loader === 'forge') return getForgeBuilds(gameVersion);
    if (loader === 'optifine') return getOptiFineBuilds(gameVersion);
    if (loader === 'fabric') return getFabricLoaders(gameVersion);
    return [];
  });

  ipcMain.handle('mods:search', async (_event, payload = {}) => {
    const data = await searchModrinth({
      query: String(payload.query || ''),
      gameVersion: String(payload.gameVersion || ''),
      loader: payload.loader ? String(payload.loader) : '',
      limit: Number(payload.limit) || 20,
    });
    return data;
  });

  ipcMain.handle('mods:install', async (_event, payload = {}) => {
    const result = await installModrinthMod({
      projectId: String(payload.projectId || ''),
      gameVersion: String(payload.gameVersion || ''),
      loader: payload.loader ? String(payload.loader) : '',
      modsDir: store.gameDir(),
      isCancelled: () => false,
    });
    return result;
  });

  ipcMain.handle('game:launch', async (_event, { versionId }) => {
    if (!versionId) return { ok: false, error: 'Версия не выбрана' };
    if (game.isRunning()) return { ok: false, error: 'Игра уже запущена' };

    const settings = store.getSettings();
    let account = store.getSelectedAccount();
    if (!account) return { ok: false, error: 'Сначала добавьте игровой аккаунт' };

    try {
      account = await prepareAccountForLaunch(account, versionId);
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        authRequired: true,
        code: error.code,
      };
    }

    let record = await getInstalledRecord(versionId, settings.gameDir);
    let installedNow = false;
    let installLoader = null;

    if (!record) {
      if (String(versionId).startsWith('fabric-loader-')) {
        const info = await getFabricInfoForVersion(versionId, settings.gameDir).catch(() => null);
        if (!info) {
          return {
            ok: false,
            error: 'Fabric-сборка не установлена. Установите её в разделе «Версии».',
          };
        }
        installLoader = { loader: 'fabric', gameVersion: info.gameVersion, loaderVersion: info.loaderVersion };
      } else {
        installLoader = { loader: 'vanilla', gameVersion: versionId };
      }
    }

    if (!record || installLoader) {
      const jobId = `launch-${Date.now()}`;
      const job = { cancelled: false, versionId, loader: installLoader?.loader || 'vanilla' };
      installJobs.set(jobId, job);
      const targetVersionId = installLoader?.gameVersion || versionId;
      send('install:progress', {
        jobId,
        versionId: targetVersionId,
        loader: job.loader,
        stage: 'meta',
        message: 'Подготовка к установке…',
        percent: 0,
      });
      try {
        record = await installVersion({
          versionId: targetVersionId,
          loader: job.loader,
          loaderVersion: installLoader?.loaderVersion,
          gameDir: settings.gameDir,
          onProgress: (progress) =>
            send('install:progress', {
              jobId,
              versionId: targetVersionId,
              loader: job.loader,
              ...progress,
            }),
          isCancelled: () => job.cancelled,
        });
        installedNow = true;
        send('install:done', {
          jobId,
          versionId: targetVersionId,
          loader: job.loader,
          record,
          installed: await getVersionList(settings.gameDir).then((data) => data.installed),
        });
      } catch (error) {
        send('install:error', {
          jobId,
          versionId: targetVersionId,
          loader: job.loader,
          error: error?.message || 'Не удалось установить версию',
          cancelled: Boolean(error?.cancelled),
        });
        return { ok: false, error: error?.message || 'Не удалось установить версию' };
      } finally {
        installJobs.delete(jobId);
      }
    } else {
      const validation = await game.validateInstallation(record, settings.gameDir);
      if (!validation.ok) {
        const jobId = `repair-${Date.now()}`;
        const loader = ['fabric', 'forge', 'optifine'].includes(record.loader)
          ? record.loader
          : 'vanilla';
        const targetVersionId = record.gameVersion || record.id;
        send('install:progress', {
          jobId,
          versionId: targetVersionId,
          loader,
          stage: 'meta',
          message: 'Восстановление файлов версии…',
          percent: 0,
        });
        try {
          record = await installVersion({
            versionId: targetVersionId,
            loader,
            loaderVersion: record.loaderVersion,
            gameDir: settings.gameDir,
            onProgress: (progress) =>
              send('install:progress', {
                jobId,
                versionId: targetVersionId,
                loader,
                ...progress,
              }),
          });
        } catch (error) {
          send('install:error', {
            jobId,
            versionId: targetVersionId,
            loader,
            error: error?.message || 'Не удалось восстановить версию',
          });
          return { ok: false, error: error?.message || 'Не удалось восстановить версию' };
        }
        send('install:done', {
          jobId,
          versionId: targetVersionId,
          loader,
          record,
          installed: await getVersionList(settings.gameDir).then((data) => data.installed),
        });
      }
    }

    try {
      const result = await game.launchVersion({
        record,
        account,
        settings,
        onStatus: (status) => send('launch:status', { versionId: record.id, ...status }),
        onLog: (line, source) => send('game:log', { versionId: record.id, line, source }),
        onStarted: (info) => {
          send('game:started', {
            ...info,
            account: store.publicAccount(store.getAccount(account.id)),
          });
          if (settings.closeOnLaunch && mainWindow) mainWindow.hide();
        },
        onExit: (info) => {
          store.addPlaytime(record.id, info.seconds);
          send('game:exit', {
            ...info,
            account: store.publicAccount(store.getAccount(account.id)),
          });
          if (mainWindow && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      });
      return { ok: true, pid: result.pid, record, installedNow };
    } catch (error) {
      return { ok: false, error: error?.message || 'Не удалось запустить игру' };
    }
  });

  ipcMain.handle('game:stop', () => ({ ok: game.stopGame() }));

  ipcMain.handle('game:running', () => ({ running: game.runningInfo() }));

  ipcMain.handle('game:logs', () => game.getLogBuffer());

  ipcMain.handle('game:clear-logs', () => {
    game.clearLogBuffer();
    return { ok: true };
  });

  ipcMain.handle('news:get', async (_event, { force } = {}) => getNews(force));

  ipcMain.handle('system:detect-java', async () => {
    const list = await getJavaCandidates(true);
    return list;
  });

  ipcMain.handle('system:pick-folder', async (_event, { defaultPath } = {}) =>
    pickFolder(defaultPath || store.gameDir()),
  );

  ipcMain.handle('system:pick-java', async (_event, { defaultPath } = {}) =>
    pickJavaFile(defaultPath),
  );

  ipcMain.handle('system:open-path', async (_event, { target }) => openPath(target));

  ipcMain.handle('shell:open-external', async (_event, { url }) => openExternal(url));

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.handle('window:state', () => ({
    maximized: Boolean(mainWindow?.isMaximized()),
    fullscreen: Boolean(mainWindow?.isFullScreen()),
  }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('ru.ylayncher.app');
    store = new Store();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    for (const flow of microsoftFlows.values()) flow.cancelled = true;
    microsoftFlows.clear();
  });

  app.on('window-all-closed', () => {
    if (game.isRunning()) {
      // Keep the launcher alive in the background while Minecraft is running.
      return;
    }
    if (process.platform !== 'darwin') app.quit();
  });

  process.on('uncaughtException', (error) => {
    console.error('[main] uncaught exception:', error);
  });

  process.on('unhandledRejection', (error) => {
    console.error('[main] unhandled rejection:', error);
  });
}
