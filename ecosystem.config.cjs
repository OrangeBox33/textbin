// Конфиг pm2 для textbin. Лежит в корне задеплоенной папки на сервере.
module.exports = {
	apps: [
		{
			name: 'textbin',
			script: 'server.js',
			cwd: '/root/dev/textbin',
			instances: 1,
			// Только fork: инстанс один по определению — тексты живут в памяти
			// процесса, при cluster-режиме реплики разошлись бы по своим копиям.
			exec_mode: 'fork',
			autorestart: true,
			max_restarts: 50,
			min_uptime: '10s',
			restart_delay: 2000,
			max_memory_restart: '200M',
			time: true,
			env: {
				NODE_ENV: 'production',
				// 3500 и 81 заняты kvadrat
				PORT: 8090,
				// Каталог данных — рядом, но НЕ внутри деплой-папки:
				// иначе rsync --delete снёс бы тексты при следующем деплое.
				DATA_DIR: '/root/dev/textbin-data',
				// Сервис отдаётся на подпути nikitosfrolov.ru/textbin
				BASE_PATH: '/textbin',
			},
		},
	],
};
