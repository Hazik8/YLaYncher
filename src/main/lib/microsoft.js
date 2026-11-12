'use strict';

/**
 * Microsoft / Xbox Live authentication for Minecraft: Java Edition.
 *
 * Uses the OAuth 2.0 device-code flow, so the launcher never has to open a
 * local callback server and works the same on Windows, macOS and Linux.
 *
 * The client ID can be replaced with a custom Azure application:
 *   YL_MICROSOFT_CLIENT_ID=<application-id>
 * The default is the public client used by the open-source Prism Launcher.
 */

const { sleep } = require('./http');
const crypto = require('crypto');

const DEFAULT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const CLIENT_ID = String(process.env.YL_MICROSOFT_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
const SCOPE = 'XboxLive.signin offline_access';
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const DEVICE_CODE_URL = `${AUTHORITY}/devicecode`;
const TOKEN_URL = `${AUTHORITY}/token`;
const XBOX_USER_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/license';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const USER_AGENT = 'YLaYncher/1.0 (Minecraft Java Launcher)';

class AuthError extends Error {
  constructor(message, code = 'AUTH_ERROR', details = null) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.details = details;
  }
}

function cancelledError() {
  const error = new AuthError('Вход отменён', 'CANCELLED');
  error.cancelled = true;
  return error;
}

function shorten(text, length = 240) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function friendlyRequestError(data, status) {
  const code = data?.error;
  if (code === 'unauthorized_client') {
    return 'Microsoft отклонил запрос приложения. Проверьте YL_MICROSOFT_CLIENT_ID.';
  }
  if (code === 'invalid_grant') {
    return 'Сессия Microsoft истекла. Войдите в аккаунт заново.';
  }
  if (code === 'invalid_request') {
    return 'Microsoft отклонил параметры запроса. Попробуйте войти ещё раз.';
  }
  const description = data?.error_description || data?.Message || data?.message;
  if (description) return shorten(description);
  return `Microsoft вернул ошибку HTTP ${status}`;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000);
  try {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AuthError('Microsoft не ответил вовремя. Проверьте интернет и попробуйте снова.', 'TIMEOUT');
      }
      throw new AuthError(
        'Не удалось связаться с Microsoft. Проверьте интернет или прокси.',
        'NETWORK',
        error,
      );
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const error = new AuthError(friendlyRequestError(data, response.status), data?.error || `HTTP_${response.status}`, data);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTokens(data) {
  return {
    accessToken: data?.access_token || '',
    refreshToken: data?.refresh_token || '',
    expiresIn: Math.max(60, Number(data?.expires_in) || 3600),
    tokenType: data?.token_type || 'Bearer',
    scope: data?.scope || '',
    idToken: data?.id_token || '',
  };
}

function dashUuid(value) {
  const hex = String(value || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return String(value || '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapXstsError(details) {
  const code = Number(details?.XErr);
  if (code === 2148916233) {
    return 'У аккаунта Microsoft нет профиля Xbox. Войдите на xbox.com и создайте профиль, затем повторите вход.';
  }
  if (code === 2148916235) {
    return 'Xbox Live недоступен в регионе этого аккаунта.';
  }
  if (code === 2148916236 || code === 2148916237) {
    return 'Xbox Live требует проверку возраста. Подтвердите возраст на xbox.com и повторите вход.';
  }
  if (code === 2148916238) {
    return 'Это детский аккаунт. Добавьте его в семейную группу Microsoft и разрешите вход.';
  }
  return `Xbox Live отклонил вход${code ? ` (код ${code})` : ''}. Попробуйте войти заново.`;
}

async function startDeviceCode() {
  const data = await requestJson(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  });

  if (!data?.device_code || !data?.user_code) {
    throw new AuthError('Microsoft не вернул код входа. Попробуйте ещё раз.', 'DEVICE_CODE_FAILED', data);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://www.microsoft.com/link',
    expiresIn: Math.max(60, Number(data.expires_in) || 900),
    interval: Math.max(3, Number(data.interval) || 5),
    message: data.message || '',
  };
}

async function pollDeviceCode({ deviceCode, interval = 5, expiresIn = 900, isCancelled, onStatus }) {
  const deadline = Date.now() + Math.max(60, Number(expiresIn) || 900) * 1000;
  let waitSeconds = Math.max(3, Number(interval) || 5);
  onStatus?.({ stage: 'waiting', message: 'Ожидаем подтверждение в браузере…' });

  while (Date.now() < deadline) {
    if (isCancelled?.()) throw cancelledError();
    await sleep(waitSeconds * 1000);
    if (isCancelled?.()) throw cancelledError();

    try {
      const data = await requestJson(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: deviceCode,
        }),
      });
      return normalizeTokens(data);
    } catch (error) {
      const code = error?.details?.error;
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        waitSeconds = Math.min(30, waitSeconds + 5);
        continue;
      }
      if (code === 'expired_token') {
        throw new AuthError('Код входа истёк. Начните вход заново.', 'CODE_EXPIRED', error.details);
      }
      if (code === 'authorization_declined') {
        throw new AuthError('Вход отменён в браузере.', 'DECLINED', error.details);
      }
      if (code === 'bad_verification_code') {
        throw new AuthError('Microsoft не принял код входа. Начните вход заново.', 'BAD_CODE', error.details);
      }
      throw error;
    }
  }

  throw new AuthError('Код входа истёк. Начните вход заново.', 'CODE_EXPIRED');
}

async function refreshMicrosoft(refreshToken) {
  if (!refreshToken) {
    throw new AuthError('Сессия Microsoft истекла. Войдите в аккаунт заново.', 'AUTH_REQUIRED');
  }
  try {
    const data = await requestJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
        scope: SCOPE,
      }),
    });
    return normalizeTokens(data);
  } catch (error) {
    if (error?.details?.error === 'invalid_grant' || error?.code === 'invalid_grant') {
      throw new AuthError('Сессия Microsoft истекла. Войдите в аккаунт заново.', 'AUTH_REQUIRED', error.details);
    }
    throw error;
  }
}

async function authenticateXbox(accessToken) {
  const xbox = await requestJson(XBOX_USER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-xbl-contract-version': '1',
    },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });

  if (!xbox?.Token) {
    throw new AuthError('Xbox Live не выдал токен. Попробуйте войти заново.', 'XBOX_TOKEN');
  }

  let xsts;
  try {
    xsts = await requestJson(XSTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xbl-contract-version': '1',
      },
      body: JSON.stringify({
        Properties: {
          SandboxId: 'RETAIL',
          UserTokens: [xbox.Token],
        },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      }),
    });
  } catch (error) {
    if (error?.details?.XErr) {
      throw new AuthError(mapXstsError(error.details), `XSTS_${error.details.XErr}`, error.details);
    }
    throw error;
  }

  if (!xsts?.Token) {
    throw new AuthError('Xbox Live не выдал XSTS-токен. Попробуйте войти заново.', 'XSTS_TOKEN');
  }

  const claims = xsts.DisplayClaims?.xui?.[0] || xbox.DisplayClaims?.xui?.[0] || {};
  return {
    uhs: claims.uhs || '',
    xuid: claims.xid || '',
    token: xsts.Token,
  };
}

async function loginWithTokens(tokens, { onStatus } = {}) {
  if (!tokens?.accessToken) {
    throw new AuthError('Microsoft не выдал токен доступа. Попробуйте войти заново.', 'MICROSOFT_TOKEN');
  }

  onStatus?.({ stage: 'xbox', message: 'Подключаем Xbox Live…' });
  const xbox = await authenticateXbox(tokens.accessToken);
  if (!xbox.uhs) {
    throw new AuthError('Xbox Live не вернул идентификатор пользователя. Попробуйте войти заново.', 'XBOX_USER');
  }

  onStatus?.({ stage: 'minecraft', message: 'Проверяем лицензию Minecraft…' });
  let minecraft;
  try {
    minecraft = await requestJson(MINECRAFT_LOGIN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityToken: `XBL3.0 x=${xbox.uhs};${xbox.token}` }),
    });
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      throw new AuthError(
        'Minecraft отклонил вход. Убедитесь, что аккаунт владеет Minecraft: Java Edition.',
        'MINECRAFT_LOGIN',
        error.details,
      );
    }
    throw error;
  }

  if (!minecraft?.access_token) {
    throw new AuthError('Minecraft не выдал токен доступа. Попробуйте войти заново.', 'MINECRAFT_TOKEN');
  }

  const auth = {
    microsoftRefreshToken: tokens.refreshToken || '',
    microsoftAccessToken: tokens.accessToken,
    microsoftExpiresAt: Date.now() + (Number(tokens.expiresIn) || 3600) * 1000,
    minecraftAccessToken: minecraft.access_token,
    minecraftExpiresAt: Date.now() + (Number(minecraft.expires_in) || 86400) * 1000,
    xuid: xbox.xuid || '',
    userType: 'msa',
    obtainedAt: new Date().toISOString(),
  };

  let entitlements;
  try {
    entitlements = await requestJson(
      `${MINECRAFT_ENTITLEMENTS_URL}?requestId=${encodeURIComponent(crypto.randomUUID())}`,
      {
        headers: { authorization: `Bearer ${auth.minecraftAccessToken}` },
      },
    );
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      throw new AuthError('Не удалось проверить лицензию Minecraft. Войдите заново.', 'ENTITLEMENTS', error.details);
    }
    throw error;
  }

  const items = Array.isArray(entitlements?.items) ? entitlements.items : [];
  const canPlay = items.some((item) => {
    const itemName = typeof item === 'string' ? item : item?.name;
    return itemName === 'game_minecraft' || itemName === 'product_minecraft';
  });
  if (!canPlay) {
    throw new AuthError(
      'На этом аккаунте Microsoft нет лицензии Minecraft: Java Edition. Купите игру или войдите другим аккаунтом.',
      'NOT_OWNED',
      entitlements,
    );
  }

  onStatus?.({ stage: 'profile', message: 'Загружаем профиль Minecraft…' });
  let profile;
  try {
    profile = await requestJson(MINECRAFT_PROFILE_URL, {
      headers: { authorization: `Bearer ${auth.minecraftAccessToken}` },
    });
  } catch (error) {
    if (error?.status === 404) {
      throw new AuthError(
        'У аккаунта нет профиля Minecraft. Создайте игровой профиль на minecraft.net и повторите вход.',
        'NO_PROFILE',
        error.details,
      );
    }
    throw error;
  }

  if (!profile?.id || !profile?.name) {
    throw new AuthError('Minecraft не вернул профиль игрока. Попробуйте войти заново.', 'NO_PROFILE');
  }

  return {
    auth,
    profile: {
      id: dashUuid(profile.id),
      name: String(profile.name),
      skins: Array.isArray(profile.skins) ? profile.skins : [],
    },
  };
}

/**
 * Refresh the Minecraft session when it is missing or close to expiry.
 * Returns the current auth object when the stored session is still valid.
 */
async function ensureSession({ auth, onStatus, force = false }) {
  const expiresAt = Number(auth?.minecraftExpiresAt) || 0;
  const valid = Boolean(auth?.minecraftAccessToken) && expiresAt - Date.now() > 5 * 60 * 1000;
  if (valid && !force) return { auth, profile: null };

  if (!auth?.microsoftRefreshToken) {
    throw new AuthError('Сессия Microsoft истекла. Войдите в аккаунт заново.', 'AUTH_REQUIRED');
  }

  onStatus?.({ stage: 'auth', message: 'Обновляем сессию Microsoft…' });
  const tokens = await refreshMicrosoft(auth.microsoftRefreshToken);
  const session = await loginWithTokens(
    { ...tokens, refreshToken: tokens.refreshToken || auth.microsoftRefreshToken },
    { onStatus },
  );
  return session;
}

module.exports = {
  AuthError,
  CLIENT_ID,
  startDeviceCode,
  pollDeviceCode,
  refreshMicrosoft,
  loginWithTokens,
  ensureSession,
  dashUuid,
};
