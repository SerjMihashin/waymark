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

## MCP-инструменты

| Инструмент | Описание |
|---|---|
| `project_list` | Все проекты со статусом |
| `project_get` | Детали одного проекта |
| `project_upsert` | Создать / обновить проект |
| `project_set_status` | Сменить статус |
| `memory_write` | Записать факт / решение |
| `memory_read` | Прочитать запись по имени |
| `memory_list` | Список памяти проекта |
| `memory_search` | Полнотекстовый поиск (FTS5) |
| `task_create` | Создать задачу-handoff |
| `task_list` | Список задач с фильтрами |
| `task_update` | Обновить статус задачи |
| `session_log` | Записать итог сессии |

## Протокол работы

**В начале каждой сессии:**
```
project_list()                                    # ориентация
memory_list(project_id="D--Projects-Kuda83")      # контекст проекта
task_list(assigned_to="claude-code", status="pending")  # входящие задачи
```

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
projects      -- реестр проектов
memory_nodes  -- общая память (+ FTS5-индекс для поиска)
tasks         -- очередь задач для handoff
sessions      -- лог сессий по поверхностям
```

БД находится в `data/hub.db` и монтируется как volume в контейнере.

## Health check

```powershell
curl http://localhost:3747/health
# {"status":"ok","server":"claudeplus-hub","version":"1.0.0"}
```
