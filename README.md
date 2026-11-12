# Y LaYncher

Красивый и быстрый лаунчер Minecraft: Java Edition с русским интерфейсом.

![Electron](https://img.shields.io/badge/Electron-33-2b2e3a)
![Minecraft](https://img.shields.io/badge/Minecraft-Java%20Edition-a8f56a)
![Fabric](https://img.shields.io/badge/Fabric-supported-9b83ff)
![Forge](https://img.shields.io/badge/Forge-supported-ffc15e)
![OptiFine](https://img.shields.io/badge/OptiFine-supported-a8f56a)

## Возможности

- Установка любых версий Minecraft: Java Edition напрямую с серверов Mojang.
- Установка модлоадеров Fabric, Forge и OptiFine с выбором версии игры и сборки.
- Поддержка профилей с `inheritsFrom`: Forge и OptiFine используют родительский клиент Minecraft и корректно объединяют библиотеки и аргументы.
- Офлайн-аккаунты с ником и стабильным UUID.
- Вход через Microsoft для лицензионных аккаунтов: официальные серверы, скины и достижения. Сессия продлевается автоматически.
- Меню модов: установка и поиск модов через Modrinth, а также управление модлоадером Forge.
- Автоматический поиск Java и загрузка официальной среды Mojang, если подходящей версии нет.
- Выбор версии игры, памяти, разрешения окна, полноэкранного режима и дополнительных JVM-аргументов.
- Живой прогресс установки: этапы, скорость, проценты, отмена.
- Встроенная консоль с логами запуска и подсказками при типичных ошибках.
- Список установленных версий, удаление, открытие папок версии/модов/логов.
- Новости Minecraft, статистика игрового времени и аватары по нику.
- Тёмный стеклянный интерфейс с кастомным заголовком окна и анимациями.

## Требования

- Windows 10/11, macOS или Linux.
- Node.js 18+ и npm.
- Интернет для установки версий, модлоадеров и загрузки Java.
- Java 8+ для legacy-версий и Java 17/21 для современных сборок Forge/OptiFine.

## Запуск

Откройте терминал в папке проекта и выполните:

```powershell
npm.cmd start
```

Либо просто дважды щёлкните по `start.cmd` — он сам проверит зависимости и откроет лаунчер.

Для запуска с DevTools:

```powershell
npm.cmd run dev
```

Первая установка зависимостей (если папки `node_modules` нет):

```powershell
npm.cmd install
```

> В PowerShell команду `npm` нужно вызывать как `npm.cmd` из-за политики выполнения скриптов.

## Сборка установщика

```powershell
npm.cmd run dist
```

Готовый установщик появится в папке `dist`. Для сборки используется `electron-builder` (NSIS).

## Сайт и релизы

В папке `site/` лежит статический сайт лаунчера. Он публикуется бесплатно на GitHub Pages через GitHub Actions, а список версий и кнопки скачивания берёт из GitHub Releases. Сборка установщика по тегу `v*` тоже настроена.

```powershell
npm.cmd run site
```

Подробная инструкция по публикации, выпуску релизов и альтернативным хостингам — в [SITE.md](SITE.md).

## Где хранятся данные

- Игра, версии, библиотеки и ресурсы: `%APPDATA%\.minecraft` по умолчанию. Папку можно изменить в настройках.
- Настройки лаунчера: `%APPDATA%\y-layncher\config.json` (точный путь зависит от имени приложения Electron).
- Токены Microsoft хранятся в `config.json` и шифруются через `safeStorage` (DPAPI на Windows), если ОС поддерживает шифрование. Пароль Microsoft лаунчер не получает и не хранит.
- Скачанные среды Java: `%APPDATA%\y-layncher\runtime`.
- Кэш метаданных: `%APPDATA%\y-layncher\cache`.

## Ограничения

- Поддерживаются vanilla, Fabric, Forge и OptiFine. Сторонние профили с `inheritsFrom` также отображаются, если их родительская версия и файлы доступны.
- Для установки Forge и OptiFine используется официальный установщик, поэтому нужен интернет и подходящая Java. Установщики работают в выбранной папке игры.
- Вход через Microsoft использует OAuth 2.0 Device Code Flow. Для собственной сборки можно указать свой Azure Application ID в переменной окружения `YL_MICROSOFT_CLIENT_ID`; по умолчанию используется публичный client ID Prism Launcher.
- Для аккаунта Microsoft нужна лицензия Minecraft: Java Edition и созданный профиль Minecraft. Детские аккаунты и аккаунты без Xbox-профиля могут требовать дополнительной настройки на сайте Microsoft/Xbox.
- Моды устанавливаются вручную в папку `mods`. Лаунчер не является менеджером модов.
- Перед удалением версии лаунчер удаляет только её папку `versions/<id>`; библиотеки и ресурсы остаются общими.

## Структура

```text
assets/                 иконки, шрифты и Java-помощник OptiFine
src/main/main.js        Electron main, IPC, запуск игры
src/main/lib/http.js    загрузки, хэши, прогресс
src/main/lib/mojang.js  манифест, библиотеки, ресурсы, Fabric/Forge/OptiFine
src/main/lib/mods.js    Modrinth: поиск и установка модов
src/main/lib/launcher.js аргументы Java, inherited-профили и процесс Minecraft
src/main/lib/microsoft.js OAuth Microsoft, Xbox Live и сессия Minecraft
src/main/lib/system.js  Java, пути, системная информация
src/main/lib/store.js   настройки, аккаунты, статистика
src/main/lib/news.js    новости Mojang
src/renderer/           интерфейс (HTML/CSS/JS)
src/preload.js          мост contextBridge
tools/make-icon.py      генератор иконки
```
