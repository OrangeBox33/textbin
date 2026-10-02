#!/usr/bin/env bash
#
# Деплой textbin на nikitosfrolov.ru/textbin одной командой.
#
#   ./deploy.sh              залить и перезапустить pm2
#   ./deploy.sh --setup      однократная настройка сервера (pm2, каталог данных, автозапуск)
#   ./deploy.sh --logs       живые логи (pm2 logs)
#   ./deploy.sh --status     что сейчас крутится
#   ./deploy.sh --restart    перезапустить, ничего не заливая
#   ./deploy.sh --dry-run    показать, что бы залилось, но не заливать
#   ./deploy.sh --nginx      поставить/обновить location /textbin/ в nginx (nikitosfrolov.ru)
#   ./deploy.sh --backup     скачать тексты с сервера в ./backup/
#
# Сборки нет: зависимостей ноль, на сервер уезжает сам server.js.
#
# Раскладка на сервере:
#   /root/dev/textbin/          server.js, package.json, ecosystem.config.cjs
#   /root/dev/textbin-data/     тексты (.md) и .history — НЕ трогается деплоем

set -euo pipefail

REMOTE="${TEXTBIN_REMOTE:-root@193.124.203.221}"
REMOTE_DIR="${TEXTBIN_REMOTE_DIR:-/root/dev/textbin}"
DATA_DIR="${TEXTBIN_DATA_DIR:-/root/dev/textbin-data}"
APP_NAME="textbin"
PORT=8090
BASE_PATH="/textbin"
PUBLIC_URL="https://nikitosfrolov.ru${BASE_PATH}"
# Сайт nikitosfrolov.ru подключает все *.conf из этой папки (репо nikitosfrolov).
NGINX_SNIPPET="/etc/nginx/snippets/nikitosfrolov/textbin.conf"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# node/npm/pm2 стоят через nvm, а неинтерактивный ssh не читает профиль.
REMOTE_ENV='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";'

MODE="deploy"
DRY_RUN=0

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
		--nginx) MODE="nginx" ;;
		--backup) MODE="backup" ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*) die "неизвестный аргумент: $1" ;;
	esac
	shift
done

# ── Nginx ──────────────────────────────────────────────────────────────────
# Кладём фрагмент в папку, которую подключает сайт. Если nginx -t не прошёл,
# возвращаем прежний фрагмент (или убираем новый, если прежнего не было).
if [ "$MODE" = "nginx" ]; then
	say "Nginx: location $BASE_PATH/"
	scp -q "$ROOT/deploy/nginx.textbin.conf" "$REMOTE:/tmp/textbin.conf"
	remote "set -e
		mkdir -p \$(dirname $NGINX_SNIPPET)
		[ -f $NGINX_SNIPPET ] && cp $NGINX_SNIPPET /tmp/textbin.conf.bak || rm -f /tmp/textbin.conf.bak
		mv /tmp/textbin.conf $NGINX_SNIPPET
		if nginx -t 2>/tmp/textbin-nginx-t.log; then
			systemctl reload nginx && echo '    nginx -t ок, конфиг перечитан'
		else
			cat /tmp/textbin-nginx-t.log
			if [ -f /tmp/textbin.conf.bak ]; then mv /tmp/textbin.conf.bak $NGINX_SNIPPET; else rm -f $NGINX_SNIPPET; fi
			echo '    nginx -t не прошёл — фрагмент откачен'
			exit 1
		fi"
	ok "$NGINX_SNIPPET"
	exit 0
fi

# ── Разовая настройка сервера ──────────────────────────────────────────────
if [ "$MODE" = "setup" ]; then
	say "Настраиваю сервер $REMOTE"

	remote 'command -v pm2 >/dev/null || npm install -g pm2'
	ok "pm2 на месте: $(remote 'pm2 -v' | tail -1)"

	say "Создаю каталог данных $DATA_DIR"
	remote "mkdir -p $DATA_DIR $REMOTE_DIR"
	ok "готово"

	say "Проверяю, свободен ли порт $PORT"
	remote "ss -ltnp | grep -q ':$PORT ' && echo ЗАНЯТ || echo свободен"

	say "Что слушает 443 (нужно, чтобы подвесить $BASE_PATH)"
	remote "ss -ltnp | grep -E ':(80|443) ' || true"
	remote "command -v nginx >/dev/null && nginx -v 2>&1 || echo 'nginx не найден'"

	say "Включаю автозапуск pm2 после ребута"
	remote 'pm2 startup systemd -u root --hp /root' | tail -3

	printf '\n\033[1;32mДальше: ./deploy.sh и ./deploy.sh --nginx\033[0m\n'
	exit 0
fi

if [ "$MODE" = "logs" ]; then
	say "Логи $APP_NAME (Ctrl+C чтобы выйти)"
	ssh -t "$REMOTE" "$REMOTE_ENV pm2 logs $APP_NAME --lines 100"
	exit 0
fi

if [ "$MODE" = "status" ]; then
	remote "pm2 list && pm2 info $APP_NAME | head -25"
	remote "du -sh $DATA_DIR && find $DATA_DIR -name '*.md' -not -path '*/.history/*' | wc -l | xargs echo 'текстов:'"
	exit 0
fi

if [ "$MODE" = "restart" ]; then
	say "Перезапускаю $APP_NAME"
	remote "cd $REMOTE_DIR && pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 list"
	exit 0
fi

if [ "$MODE" = "backup" ]; then
	say "Скачиваю тексты с сервера в $ROOT/backup"
	mkdir -p "$ROOT/backup"
	rsync -az --human-readable "$REMOTE:$DATA_DIR/" "$ROOT/backup/"
	ok "$(find "$ROOT/backup" -name '*.md' | wc -l | tr -d ' ') файлов в ./backup"
	exit 0
fi

# ── Деплой ────────────────────────────────────────────────────────────────
[ -f "$ROOT/server.js" ] || die "нет server.js"
node --check "$ROOT/server.js" || die "server.js не проходит проверку синтаксиса"

RSYNC_OPTS=(
	-az --delete --human-readable --itemize-changes
	--exclude 'data'
	--exclude 'backup'
	--exclude 'deploy'
	--exclude '.git'
	--exclude '.DS_Store'
	--exclude 'node_modules'
)

if [ "$DRY_RUN" = "1" ]; then
	say "Пробный прогон (ничего не меняем) -> $REMOTE:$REMOTE_DIR"
	rsync "${RSYNC_OPTS[@]}" --dry-run "$ROOT/" "$REMOTE:$REMOTE_DIR/"
	exit 0
fi

say "Заливаю на $REMOTE:$REMOTE_DIR"
rsync "${RSYNC_OPTS[@]}" "$ROOT/" "$REMOTE:$REMOTE_DIR/"

say "Перезапускаю $APP_NAME"
remote "mkdir -p $DATA_DIR"
remote "cd $REMOTE_DIR && pm2 startOrRestart ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && pm2 list"

say "Проверяю, что сервис отвечает"
remote "curl -sf http://127.0.0.1:$PORT$BASE_PATH/healthz" || die "healthz не ответил — смотри ./deploy.sh --logs"
ok "healthz: ok"

say "Последние строки лога"
remote "pm2 logs $APP_NAME --lines 15 --nostream"

printf '\n\033[1;32mГотово: %s/\033[0m\n' "$PUBLIC_URL"
printf 'Логи: ./deploy.sh --logs   Бэкап текстов: ./deploy.sh --backup\n'
