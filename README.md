# ClaudePlus Hub

Локальный MCP-сервер для объединения всех Claude-поверхностей в единое рабочее пространство.

## Проблема

Claude Desktop, Claude Code, Claude.ai web и browser agent — изолированные сессии. Каждый раз при переключении теряется контекст: что делалось, какие решения приняты, в каком состоянии проект.

## Решение

Единый MCP-сервер с общей SQLite-базой, к которому подключаются все поверхности. Даёт:

- **Общий реестр проектов** — стек, статус, описание
- **Общая память** — решения, факты, предпочтения с полнотекстовым поиском
- **Очередь задач** — handoff между поверхностями без потери контекста
- **Лог сессий** — история кто что делал и когда

## Требования

- Node.js v22+
- Podman 5+ с podman-compose (или Docker)

## Установка

```powershell
git clone <repo>
cd ClaudePlus
npm install
npm run build
```

### Запуск через Podman (рекомендуется)

```powershell
podman compose up -d
```

Сервер доступен на `http://localhost:3747/mcp`

### Запуск напрямую (без контейнера)

```powershell
# Режим Claude Code (stdio) — автозапуск через MCP
node dist/server.js

# HTTP-режим для Desktop / Web
.\start-hub.ps1
# или: node dist/server.js --http
```

## Подключение Claude-поверхностей

### Claude Code

Уже настроено глобально. Проверить:
```powershell
claude mcp list
# → claudeplus ✓ Connected
```

Переподключить вручную:
```powershell
claude mcp add --scope user claudeplus node "D:\Projects\ClaudePlus\dist\server.js"
```

### Claude Desktop / Claude.ai web

1. Запустить hub: `podman compose up -d`
2. Открыть настройки Claude → **Connectors** → **Add custom connector**
3. Вставить URL: `http://localhost:3747/mcp`

## MCP-инструменты (28)

Полный справочник с сигнатурами — в [AGENTS.md](./AGENTS.md). Группы:

| Группа | Инструменты |
|---|---|
| Контекст | `workspace_resume`, `context_get` |
| Проекты | `project_list/get/upsert/set_status` |
| Память | `memory_write/read/list/search/set_status/feedback` |
| Задачи | `task_create/list/update/claim/release/add_dependency` |
| Агенты | `agent_register/get/list/set_status` |
| Сессии и телеметрия | `session_log`, `usage_report`, `experiment_create/list/update/summary` |

## Протокол работы

**В начале сессии — один компактный вызов** (заменяет старую связку из трёх):
```
workspace_resume(project_id="D--Projects-Kuda83", task="...", max_tokens=1200)
```
Возвращает проект, активные задачи и ранжированную память в пределах токен-бюджета.
Детали тянутся по id (`memory_read`, `context_get`) только при необходимости.

**В конце сессии:**
```
session_log(started_at=..., summary="...", outcome="completed")
memory_write(name="decision-xyz", body="...")     # новые решения
```

**Handoff на другую поверхность:**
```
task_create(
  title="Проверить верстку в браузере",
  assigned_to="browser-agent",
  context_json={"url": "http://localhost:3000", "page": "главная"}
)
```

## Разработка

```powershell
npm run dev         # stdio-режим с tsx (hot reload не нужен для MCP)
npm run dev:http    # HTTP-режим
npm run build       # компиляция TypeScript
npm run import:memory  # импорт из ~/.claude/projects/*/memory/
```

## Структура БД

```sql
projects           -- реестр проектов
memory_nodes       -- общая память (+ FTS5-индекс, статусы, importance/confidence)
memory_feedback    -- оценки полезности записей
tasks              -- очередь задач + handoff (claim, capabilities)
task_dependencies  -- зависимости между задачами
agents             -- provider-neutral идентичности агентов
sessions           -- лог сессий (+ agent/provider/model/usage)
experiments        -- A/B-бенчмарки Hub vs no-Hub
```

Схема ведётся миграциями `001..005` в `src/db/migrations/` (обратно-совместимо).

БД находится в `data/hub.db` и монтируется как volume в контейнере.

## Health check

```powershell
curl http://localhost:3747/health
# {"status":"ok","server":"claudeplus-hub","version":"1.0.0"}
```
