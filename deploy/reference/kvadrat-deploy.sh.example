#!/usr/bin/env bash
#
# Деплой kvadratnikitosa.ru на прод одной командой.
#
#   ./deploy.sh              собрать клиент + сервер, залить, перезапустить pm2
#   ./deploy.sh --setup      однократная настройка сервера (pm2, автозапуск)
#   ./deploy.sh --logs       живые логи сервера (pm2 logs)
#   ./deploy.sh --status     что сейчас крутится на сервере
#   ./deploy.sh --restart    перезапустить, ничего не собирая и не заливая
#   ./deploy.sh --no-build   залить то, что уже собрано локально
#   ./deploy.sh --dry-run    показать, что бы залилось, но не заливать
#
# Раскладка на сервере (её ждёт server.js: статика — ../public от dist/server):
#   /root/dev/kvadrat/dist/
#     ├── server/            скомпилированный сервер (+ save.json и palette.json, их не трогаем)
#     ├── shared/            общий код
#     ├── public/            собранный клиент (vite)
#     ├── package.json       зависимости сервера
#     ├── package-lock.json
#     ├── ecosystem.config.cjs
#     └── node_modules/      ставится на сервере через npm, не заливается

set -euo pipefail

REMOTE="${KVADRAT_REMOTE:-root@193.124.203.221}"
REMOTE_DIR="${KVADRAT_REMOTE_DIR:-/root/dev/kvadrat/dist}"
APP_NAME="kvadrat"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$ROOT/.deploy"

# node/npm/pm2 на сервере стоят через nvm, а неинтерактивный ssh не читает профиль,
# поэтому каждую удалённую команду начинаем с подгрузки nvm.
REMOTE_ENV='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";'

BUILD=1
DRY_RUN=0
MODE="deploy"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    %s\033[0m\n' "$*"; }
die() {
	printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2
	exit 1
}

remote() { ssh "$REMOTE" "$REMOTE_ENV $*"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--setup) MODE="setup" ;;
		--logs) MODE="logs" ;;
		--status) MODE="status" ;;
		--restart) MODE="restart" ;;
		--no-build) BUILD=0 ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*) die "неизвестный аргумент: $1" ;;
	esac
	shift
done

# ── Разовая настройка сервера ──────────────────────────────────────────────
if [ "$MODE" = "setup" ]; then
	say "Настраиваю сервер $REMOTE"

	remote 'command -v pm2 >/dev/null || npm install -g pm2'
	ok "pm2 на месте: $(remote 'pm2 -v' | tail -1)"

	say "Гашу сервер, запущенный руками (если он есть)"
	# Тот самый `node server.js`, поднятый из терминала: он держит порты 3500 и 81,
	# и без него pm2 не сможет забиндиться.
	remote "pkill -f 'node server.js' || true"
	ok "готово"

	say "Включаю автозапуск pm2 после ребута сервера"
	remote 'pm2 startup systemd -u root --hp /root' | tail -3
	ok "готово"

	printf '\n\033[1;32mСервер готов. Теперь просто: ./deploy.sh\033[0m\n'
	exit 0
fi

if [ "$MODE" = "logs" ]; then
	say "Логи $APP_NAME (Ctrl+C чтобы выйти)"
	# -t: интерактивный tty, иначе Ctrl+C не дойдёт до pm2
	ssh -t "$REMOTE" "$REMOTE_ENV pm2 logs $APP_NAME --lines 100"
	exit 0
fi

if [ "$MODE" = "status" ]; then
	remote "pm2 list && pm2 info $APP_NAME | head -25"
	exit 0
fi

if [ "$MODE" = "restart" ]; then
	say "Перезапускаю $APP_NAME"
	remote "cd $REMOTE_DIR && pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 list"
	exit 0
fi

# ── Сборка ─────────────────────────────────────────────────────────────────
if [ "$BUILD" = "1" ]; then
	say "Собираю клиент (vite)"
	(cd "$ROOT" && npm run build)

	say "Собираю сервер (tsc)"
	# Старый dist сносим: rootDir у сервера — корень репо, и от прежних
	# раскладок в dist могли остаться файлы, которых уже нет в исходниках.
	rm -rf "$ROOT/server/dist"
	(cd "$ROOT/server" && npm run build)
fi

[ -f "$ROOT/dist/index.html" ] || die "нет dist/index.html — клиент не собран (убери --no-build)"
[ -f "$ROOT/server/dist/server/server.js" ] || die "нет server/dist/server/server.js — сервер не собран"
[ -f "$ROOT/server/dist/shared/constants.js" ] || die "нет server/dist/shared/ — проверь include в server/tsconfig.json"

# ── Раскладываем в точности то, что должно лежать на сервере ───────────────
say "Готовлю посылку в $STAGE"

rm -rf "$STAGE"
mkdir -p "$STAGE"

cp -R "$ROOT/server/dist/server" "$STAGE/server"
cp -R "$ROOT/server/dist/shared" "$STAGE/shared"
cp -R "$ROOT/dist" "$STAGE/public" # собранный клиент -> dist/public на сервере
cp "$ROOT/deploy/ecosystem.config.cjs" "$STAGE/ecosystem.config.cjs"
cp "$ROOT/server/package-lock.json" "$STAGE/package-lock.json"

# package.json берём серверный, но правим start: на сервере файл лежит в корне
# dist, поэтому путь до входной точки не dist/server/server.js, а server/server.js.
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
pkg.scripts = { start: "node server/server.js" };
fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, "\t") + "\n");
' "$ROOT/server/package.json" "$STAGE/package.json"

ok "$(find "$STAGE" -type f | wc -l | tr -d ' ') файлов"

# ── Заливаем ───────────────────────────────────────────────────────────────
RSYNC_OPTS=(
	-az --delete --human-readable --itemize-changes
	# node_modules живёт на сервере (ставится npm), save.json — состояние холста,
	# palette.json — подобранная палитра калибровки.
	# Все три исключены и из заливки, и из --delete.
	--exclude 'node_modules'
	--exclude 'save.json'
	--exclude 'palette.json'
	--exclude '.DS_Store'
)

if [ "$DRY_RUN" = "1" ]; then
	say "Пробный прогон (ничего не меняем) -> $REMOTE:$REMOTE_DIR"
	rsync "${RSYNC_OPTS[@]}" --dry-run "$STAGE/" "$REMOTE:$REMOTE_DIR/"
	exit 0
fi

say "Заливаю на $REMOTE:$REMOTE_DIR"
rsync "${RSYNC_OPTS[@]}" "$STAGE/" "$REMOTE:$REMOTE_DIR/"

# ── Зависимости и перезапуск ───────────────────────────────────────────────
say "Ставлю зависимости на сервере"
remote "cd $REMOTE_DIR && npm install --omit=dev --no-audit --no-fund" | tail -3

say "Перезапускаю $APP_NAME"
remote "cd $REMOTE_DIR && pm2 startOrRestart ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && pm2 list"

say "Последние строки лога"
remote "pm2 logs $APP_NAME --lines 15 --nostream"

printf '\n\033[1;32mГотово: https://kvadratnikitosa.ru\033[0m\n'
printf 'Логи: ./deploy.sh --logs\n'
