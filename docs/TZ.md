# Техническое задание — ClaudePlus Hub

## 1. Цель

Создать локальный MCP-сервер, который устраняет изоляцию между Claude-поверхностями: Claude Code (CLI), Claude Desktop (GUI), Claude.ai (web), Claude browser agent (computer use).

## 2. Проблема

| Поверхность | Изоляция |
|---|---|
| Claude Code | Каждая сессия — отдельный контекст |
| Claude Desktop | Не знает о работе в Code |
| Claude.ai web | Не знает ни о Code, ни о Desktop |
| Browser agent | Получает задачи устно, без структуры |

При переключении между поверхностями: потеря контекста, повторное объяснение задачи, несогласованность решений.

## 3. Решение

MCP-сервер (`claudeplus-hub`) с общим SQLite-хранилищем. Все поверхности подключаются к нему и читают/пишут один и тот же контекст.

### 3.1 Что даёт пользователю

- Начать задачу в Claude Code, продолжить в Desktop — без потери контекста
- Делегировать browser agent задачу через очередь, получить результат
- Искать любое ранее принятое решение по всем проектам одним запросом
- Видеть историю: кто, когда, что делал

### 3.2 Что технически невозможно

- Реалтайм-синхронизация между активными сессиями (Claude-сессии изолированы по дизайну)
- Автоматическое обнаружение других запущенных Claude-экземпляров
- Push-уведомления между сессиями

## 4. Функциональные требования

### FR-1: Реестр проектов
- Хранить все рабочие проекты с полями: id, name, root_path, stack, status, description
- ID совпадает со слагом из `~/.claude/projects/` для бесшовной интеграции
- CRUD-операции через MCP-инструменты
- Статусы: active | paused | archived

### FR-2: Общая память
- Хранить именованные записи памяти привязанные к проекту или глобальные
- Типы: user | feedback | project | reference | handoff | decision
- Полнотекстовый поиск (FTS5) по имени, описанию, телу и тегам
- Поле `surface` — кто записал (аудит)
- Upsert по имени в рамках проекта (обновление вместо дублирования)

### FR-3: Очередь задач (handoff)
- Создание задачи с полем `assigned_to` — целевая поверхность
- `context_json` — структурированные данные для передачи (пути файлов, URL, данные)
- Приоритеты 0-100
- Статусы: pending | in_progress | done | cancelled
- Фильтрация по статусу, проекту, поверхности

### FR-4: Лог сессий
- Запись итога сессии: что сделано, какие файлы тронуты, какие коммиты
- Outcome: completed | blocked | partial
- Привязка к проекту и поверхности

### FR-5: Транспорт
- **stdio** — для Claude Code (запускается как дочерний процесс)
- **HTTP :3747** — для Claude Desktop и Claude.ai web (флаг `--http`)
- `/health` endpoint для мониторинга

### FR-6: Импорт существующей памяти
- Разовый скрипт для импорта `.md` файлов из `~/.claude/projects/*/memory/`
- Парсинг frontmatter (name, description, type)
- Пропуск уже существующих записей

## 5. Нефункциональные требования

| Требование | Значение |
|---|---|
| Платформа | Windows 11, Node.js v22 |
| Контейнер | Podman 5+ / Docker-совместимый |
| Язык | TypeScript 6, CommonJS |
| БД | SQLite (WAL, foreign keys) |
| Время ответа | < 50мс для любого инструмента |
| Безопасность | Только localhost (0.0.0.0 внутри контейнера, порт закрыт снаружи) |
| Надёжность | WAL-режим SQLite, restart: unless-stopped в compose |

## 6. Архитектура

```
┌─────────────────────────────────────────────────────┐
│                   Claude-поверхности                 │
│  Claude Code  │  Claude Desktop  │  Claude.ai web   │
└──────┬────────┴────────┬─────────┴────────┬─────────┘
       │ stdio           │ HTTP             │ HTTP
       └────────────────┬┘─────────────────┘
                        ▼
              ┌─────────────────┐
              │ claudeplus-hub  │  Node.js 22 / TypeScript
              │  MCP Server     │  @modelcontextprotocol/sdk
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │   data/hub.db   │  SQLite (WAL)
              │                 │  + FTS5 virtual table
              └─────────────────┘
```

## 7. Схема данных

### projects
```
id TEXT PK        -- D--Projects-Kuda83
name TEXT         -- Kuda83
root_path TEXT    -- D:\Projects\Kuda83
stack TEXT        -- Laravel 12 + Nuxt 4 + MySQL
status TEXT       -- active | paused | archived
description TEXT
created_at TEXT
updated_at TEXT
```

### memory_nodes
```
id TEXT PK
project_id TEXT FK → projects
surface TEXT      -- claude-code | claude-desktop | ...
name TEXT         -- kebab-case slug
description TEXT  -- одна строка
type TEXT         -- user | feedback | project | reference | handoff | decision
body TEXT         -- полный markdown
tags TEXT         -- JSON array
origin_session TEXT
created_at, updated_at TEXT
```

### tasks
```
id TEXT PK
project_id TEXT FK → projects
title TEXT
description TEXT
status TEXT       -- pending | in_progress | done | cancelled
priority INTEGER  -- 0-100
created_by TEXT   -- surface
assigned_to TEXT  -- surface или NULL (любой)
context_json TEXT -- JSON blob для handoff
created_at, updated_at, completed_at TEXT
```

### sessions
```
id TEXT PK
project_id TEXT FK → projects
surface TEXT
started_at TEXT
ended_at TEXT
summary TEXT
files_touched TEXT  -- JSON array
commits_made TEXT   -- JSON array
outcome TEXT        -- completed | blocked | partial
```

## 8. Развёртывание

### Контейнер (основной способ)
```powershell
podman compose up -d    # запуск
podman compose down     # остановка
podman compose logs -f  # логи
```

### Без контейнера (для разработки)
```powershell
npm run build
.\start-hub.ps1       # HTTP-режим
# или: node dist/server.js  # stdio (Claude Code запускает сам)
```

### Регистрация в Claude Code
```powershell
claude mcp add --scope user claudeplus node "D:\Projects\ClaudePlus\dist\server.js"
```

### Claude Desktop / Claude.ai web
Settings → Connectors → `http://localhost:3747/mcp`

## 9. Сценарии использования

### Сценарий А: Передача задачи браузерному агенту
1. Claude Code создаёт задачу: `task_create(title="Проверить верстку", assigned_to="browser-agent", context_json={url: "..."})`
2. Записывает итог: `session_log(outcome="partial")`
3. Browser agent в новой сессии: `task_list(assigned_to="browser-agent", status="pending")`
4. Подхватывает задачу, выполняет, `task_update(status="done")`

### Сценарий Б: Возобновление работы в Desktop
1. Claude Desktop: `project_get(name="Kuda83")`
2. `memory_list(project_id="D--Projects-Kuda83")`
3. `task_list(status="pending")` — видит незакрытые задачи от Code
4. Продолжает работу с полным контекстом

### Сценарий В: Поиск прошлых решений
1. `memory_search(query="auth middleware")`
2. Находит запись из 3 недель назад от другой поверхности
3. Применяет решение, не изобретая велосипед
