'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');

const {
  exists,
  statSafe,
  downloadFile,
  splitCommandLine,
  readJson,
} = require('./http');
const {
  getPaths,
  osName,
  requiredJavaMajor,
  chooseJava,
  ensureJavaRuntime,
} = require('./system');
const {
  rulesAllow,
  getClasspath,
  getClientJarPath,
  readVersionMeta,
  extractNatives,
  collectLibraries,
} = require('./mojang');

const ANSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

let current = null;
let logBuffer = [];

function pushLog(line, source = 'game') {
  const clean = String(line).replace(ANSI_PATTERN, '').replace(/\r$/, '');
  if (!clean.trim()) return;
  logBuffer.push({ at: Date.now(), source, line: clean });
  if (logBuffer.length > 4000) logBuffer = logBuffer.slice(-3000);
}

function getLogBuffer() {
  return logBuffer.slice(-1500);
}

function clearLogBuffer() {
  logBuffer = [];
}

function substitute(value, variables) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match,
  );
}

function collectArguments(list, features) {
  const output = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      output.push(item);
      continue;
    }
    if (item && typeof item === 'object' && rulesAllow(item.rules, features)) {
      const values = Array.isArray(item.value) ? item.value : [item.value];
      for (const value of values) {
        if (typeof value === 'string') output.push(value);
      }
    }
  }
  return output;
}

function offlineAccessToken(account) {
  return crypto
    .createHash('sha256')
    .update(`YLaYncher:${account.uuid}:${account.name}`)
    .digest('hex')
    .slice(0, 32);
}

async function validateInstallation(record, gameDir) {
  const paths = getPaths(gameDir);
  const versionDir = path.join(paths.versions, record.id);
  const missing = [];
  const meta = await readVersionMeta(record.id, gameDir);
  if (!meta) return { ok: false, missing: ['version.json'] };

  const clientJar = getClientJarPath(meta, record.id, paths);
  if (!(await exists(clientJar))) missing.push('client.jar');

  const classpath = getClasspath(meta, paths.libraries);
  for (const entry of classpath) {
    if (!(await exists(entry))) {
      missing.push(path.relative(paths.gameDir, entry));
      if (missing.length > 4) break;
    }
  }

  if (meta.assetIndex?.id) {
    const index = path.join(paths.assets, 'indexes', `${meta.assetIndex.id}.json`);
    if (!(await exists(index))) missing.push('assets/index');
  }

  const nativesDir = path.join(versionDir, 'natives');
  const { natives } = collectLibraries(meta);
  if (natives.length && !(await exists(nativesDir))) missing.push('natives');

  return { ok: missing.length === 0, missing, meta };
}

async function ensureLoggingConfig(meta, paths) {
  const file = meta.logging?.client?.file;
  if (!file?.url) return null;
  const destination = path.join(paths.assets, 'log_configs', file.id);
  if (!(await exists(destination))) {
    await downloadFile(file.url, destination, {
      size: file.size,
      sha1: file.sha1,
    }).catch(() => {});
  }
  return (await exists(destination)) ? destination : null;
}

function buildCommand({ meta, versionId, account, settings, paths, java, logConfig }) {
  const features = {
    is_demo_user: false,
    has_custom_resolution: !settings.fullscreen,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const versionDir = path.join(paths.versions, versionId);
  const nativesDir = path.join(versionDir, 'natives');
  const clientJar = getClientJarPath(meta, versionId, paths);
  const classpath = [...getClasspath(meta, paths.libraries), clientJar];
  const classpathString = classpath.join(path.delimiter);
  const isMicrosoft = account.type === 'microsoft' && Boolean(account.auth?.minecraftAccessToken);
  const token = isMicrosoft ? account.auth.minecraftAccessToken : offlineAccessToken(account);
  const userType = isMicrosoft ? 'msa' : 'legacy';
  const assetsIndex = meta.assetIndex?.id || meta.assets || 'legacy';

  const variables = {
    auth_player_name: account.name,
    version_name: versionId,
    game_directory: paths.gameDir,
    assets_root: paths.assets,
    game_assets: path.join(paths.assets, 'virtual', assetsIndex),
    assets_index_name: assetsIndex,
    auth_uuid: account.uuid,
    auth_access_token: token,
    auth_session: token,
    clientid: '',
    auth_xuid: isMicrosoft ? account.auth.xuid || '' : '',
    user_type: userType,
    version_type: meta.type || 'release',
    user_properties: '{}',
    natives_directory: nativesDir,
    launcher_name: 'YLaYncher',
    launcher_version: app.getVersion(),
    classpath: classpathString,
    classpath_separator: path.delimiter,
    library_directory: paths.libraries,
    resolution_width: String(settings.width || 1280),
    resolution_height: String(settings.height || 720),
  };

  const jvm = [];
  const maxMem = Math.max(512, Math.min(65536, Number(settings.memoryMax) || 4096));
  const minMem = Math.max(256, Math.min(maxMem, Number(settings.memoryMin) || 512));
  jvm.push(`-Xmx${maxMem}M`, `-Xms${minMem}M`);
  jvm.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');

  const jvmFromMeta = collectArguments(meta.arguments?.jvm, features);
  if (jvmFromMeta.length) {
    for (const arg of jvmFromMeta) {
      let value = substitute(arg, variables);
      // Forge/OptiFine profiles inherit the vanilla client jar from their
      // parent. The loader's ignore list normally refers to the profile jar by
      // name, which does not exist for an inherited profile. Ignore the actual
      // parent jar as well, otherwise the Java module system loads it as a
      // competing automatic module (module _1._20._1 / minecraft conflicts).
      if (meta.inheritsFrom && /^-DignoreList=/i.test(value)) {
        const clientJarName = path.basename(clientJar);
        if (clientJarName && !value.includes(clientJarName)) value += `,${clientJarName}`;
      }
      jvm.push(value);
    }
  } else {
    jvm.push(`-Djava.library.path=${nativesDir}`, '-cp', classpathString);
  }

  if (!jvm.some((arg) => arg === '-cp' || arg === '-classpath')) {
    jvm.push('-cp', classpathString);
  }

  if (logConfig && meta.logging?.client?.argument) {
    jvm.push(substitute(meta.logging.client.argument, { path: logConfig }));
  }

  const customJvmArgs = Array.isArray(settings.jvmArgs)
    ? settings.jvmArgs
    : splitCommandLine(String(settings.jvmArgs || ''));
  for (const arg of customJvmArgs) {
    if (arg.trim()) jvm.push(arg.trim());
  }

  const mainClass = meta.mainClass || 'net.minecraft.client.main.Main';

  let gameArgs;
  if (Array.isArray(meta.arguments?.game)) {
    gameArgs = collectArguments(meta.arguments.game, features).map((arg) =>
      substitute(arg, variables),
    );
  } else if (meta.minecraftArguments) {
    gameArgs = splitCommandLine(meta.minecraftArguments).map((arg) =>
      substitute(arg, variables),
    );
  } else {
    gameArgs = [];
  }

  if (!gameArgs.includes('--username')) {
    gameArgs.push(
      '--username',
      account.name,
      '--version',
      versionId,
      '--gameDir',
      paths.gameDir,
      '--assetsDir',
      paths.assets,
      '--assetIndex',
      assetsIndex,
      '--uuid',
      account.uuid,
      '--accessToken',
      token,
      '--userType',
      userType,
      '--versionType',
      meta.type || 'release',
    );
  }

  if (settings.fullscreen && !gameArgs.includes('--fullscreen')) {
    gameArgs.push('--fullscreen');
  } else if (!settings.fullscreen) {
    if (!gameArgs.includes('--width') && Number(settings.width) > 0) {
      gameArgs.push('--width', String(settings.width));
    }
    if (!gameArgs.includes('--height') && Number(settings.height) > 0) {
      gameArgs.push('--height', String(settings.height));
    }
  }

  return {
    command: java.path,
    args: [...jvm, mainClass, ...gameArgs],
    cwd: paths.gameDir,
    classpath,
    java,
  };
}

function analyzeFailure(lines) {
  const text = lines.slice(-400).join('\n');
  if (!text) return null;
  if (/OutOfMemoryError|Java heap space/i.test(text)) {
    return 'Игре не хватило памяти. Увеличьте выделенную память в настройках лаунчера.';
  }
  if (/UnsupportedClassVersionError/i.test(text)) {
    return 'Версия Java не подходит для этой сборки. Выберите другую Java в настройках.';
  }
  if (/Pixel format not accelerated|Failed to create window|GLFW error|WGL: The driver does not appear to support/i.test(text)) {
    return 'Видеодрайвер не поддерживает нужный режим. Обновите драйверы видеокарты.';
  }
  if (/Could not find or load main class|ClassNotFoundException: net\.minecraft/i.test(text)) {
    return 'Файлы версии повреждены. Удалите версию и установите её заново.';
  }
  if (/Missing or unsupported mandatory dependencies|Incompatible mods|Mod resolution failed/i.test(text)) {
    return 'Конфликт модов. Проверьте папку mods и совместимость модов с версией.';
  }
  if (/The game crashed whilst|A fatal error has been detected by the Java Runtime/i.test(text)) {
    return 'Игра завершилась с ошибкой. Подробности — в консоли лаунчера и crash-reports.';
  }
  return null;
}

async function launchVersion({ record, account, settings, onStatus, onLog, onStarted, onExit, onSecret }) {
  if (current) throw new Error('Игра уже запущена');

  const paths = getPaths(settings.gameDir);
  await fsp.mkdir(paths.gameDir, { recursive: true });

  onStatus?.({ stage: 'prepare', message: 'Проверка файлов версии…', percent: 0 });
  const validation = await validateInstallation(record, settings.gameDir);
  if (!validation.ok) {
    const error = new Error(
      `Файлы версии повреждены или неполные (${validation.missing.slice(0, 3).join(', ')}). Переустановите версию.`,
    );
    error.code = 'INCOMPLETE';
    error.missing = validation.missing;
    throw error;
  }

  const meta = validation.meta;
  const required = requiredJavaMajor(meta);
  onStatus?.({ stage: 'java', message: 'Поиск Java…', percent: 0 });

  let java = await chooseJava(required, settings.javaPath);
  if (!java) {
    onStatus?.({
      stage: 'java',
      message: `Java ${required} не найдена. Скачиваем автоматически…`,
      percent: 0,
    });
    java = await ensureJavaRuntime(meta, {
      runtimeDir: paths.runtime,
      onProgress: (progress) =>
        onStatus?.({
          stage: 'java',
          message: progress.message,
          percent: progress.percent,
          doneBytes: progress.doneBytes,
          totalBytes: progress.totalBytes,
          speed: progress.speed,
        }),
    });
  }

  const logConfig = await ensureLoggingConfig(meta, paths);
  const built = buildCommand({
    meta,
    versionId: record.id,
    account,
    settings,
    paths,
    java,
    logConfig,
  });

  onSecret?.(built.args);
  onStatus?.({
    stage: 'launch',
    message: `Запуск Java ${java.version}…`,
    percent: 100,
  });

  pushLog(
    `[Launcher] Запуск ${record.displayName || record.id} · Java ${java.version} (${java.major}) · ${Math.round(
      Number(settings.memoryMax) / 1024,
    )} ГБ ОЗУ`,
    'launcher',
  );
  onLog?.(`[Launcher] Java ${java.version} · ${java.path}`, 'launcher');

  const startedAt = Date.now();
  const child = spawn(built.command, built.args, {
    cwd: built.cwd,
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    child,
    record,
    startedAt,
    stopped: false,
    recent: [],
    pending: { stdout: '', stderr: '' },
  };
  current = session;

  const emitLine = (line, source) => {
    pushLog(line, source);
    session.recent.push(line);
    if (session.recent.length > 500) session.recent.shift();
    onLog?.(line, source);
  };

  const wireStream = (stream, key) => {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => {
      const combined = session.pending[key] + chunk;
      const lines = combined.split(/\r?\n/);
      session.pending[key] = lines.pop() || '';
      for (const line of lines) emitLine(line, key === 'stderr' ? 'stderr' : 'game');
    });
  };

  wireStream(child.stdout, 'stdout');
  wireStream(child.stderr, 'stderr');

  const finish = (code, signal, error) => {
    if (!current || current !== session) return;
    current = null;
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    for (const key of ['stdout', 'stderr']) {
      const rest = session.pending[key];
      if (rest?.trim()) emitLine(rest, key === 'stderr' ? 'stderr' : 'game');
    }
    let hint = null;
    if (error) {
      hint = 'Не удалось запустить Java. Проверьте путь к Java в настройках.';
    } else if (!session.stopped && (code !== 0 || seconds < 8)) {
      hint = analyzeFailure(session.recent);
    }
    onExit?.({
      versionId: record.id,
      code: code ?? -1,
      signal: signal || null,
      seconds,
      stopped: session.stopped,
      error: error ? error.message : null,
      hint,
    });
  };

  child.on('error', (error) => {
    emitLine(`[Launcher] Ошибка запуска: ${error.message}`, 'launcher');
    finish(-1, null, error);
  });

  child.on('exit', (code, signal) => finish(code, signal, null));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Java не ответила за 20 секунд')), 20000);
    child.once('spawn', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  }).catch((error) => {
    current = null;
    throw error;
  });

  onStarted?.({
    versionId: record.id,
    displayName: record.displayName || record.id,
    pid: child.pid,
    java,
  });

  return { pid: child.pid, java, command: built };
}

function isRunning() {
  return Boolean(current);
}

function runningInfo() {
  if (!current) return null;
  return {
    versionId: current.record.id,
    displayName: current.record.displayName || current.record.id,
    startedAt: current.startedAt,
    pid: current.child.pid,
  };
}

function stopGame() {
  if (!current) return false;
  current.stopped = true;
  const pid = current.child.pid;
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      current.child.kill('SIGTERM');
    }
  } catch {
    current.child.kill();
  }
  return true;
}

module.exports = {
  launchVersion,
  validateInstallation,
  buildCommand,
  isRunning,
  runningInfo,
  stopGame,
  getLogBuffer,
  clearLogBuffer,
  pushLog,
};
