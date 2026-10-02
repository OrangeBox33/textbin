'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
// Наружу сервис отдаёт nginx, напрямую порт открывать незачем.
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
// Сервис живёт на подпути: nikitosfrolov.ru/textbin
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const MAX_BODY = 2 * 1024 * 1024;

const NS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = new Set(['new', 'raw', 'edit', 'healthz', 'favicon.ico', 'robots.txt']);

/* ---------- хранилище ----------
   Истина — в памяти: store = ns -> Map(slug -> { body, updated }).
   Каждая запись дублируется в файл DATA_DIR/<ns>/<slug>.md, чтобы пережить рестарт;
   при старте всё читается с диска обратно в память.                              */

const store = new Map();

const nsDir = (ns) => path.join(DATA_DIR, ns);
const textFile = (ns, slug) => path.join(DATA_DIR, ns, `${slug}.md`);

async function loadFromDisk() {
  store.clear();
  const dirs = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  let total = 0;

  for (const dir of dirs) {
    if (!dir.isDirectory() || !NS_RE.test(dir.name)) continue;

    const files = await fs.readdir(nsDir(dir.name), { withFileTypes: true }).catch(() => []);
    const texts = new Map();

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const slug = file.name.slice(0, -3);
      if (!SLUG_RE.test(slug)) continue;

      const full = path.join(nsDir(dir.name), file.name);
      const [body, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      texts.set(slug, { body, updated: stat.mtime });
      total += 1;
    }

    store.set(dir.name, texts);
  }

  return total;
}

const listNamespaces = () => [...store.keys()].sort();

const listTexts = (ns) =>
  [...(store.get(ns) || new Map())]
    .map(([slug, { body, updated }]) => ({ slug, updated, size: Buffer.byteLength(body) }))
    .sort((a, b) => b.updated - a.updated);

const readText = (ns, slug) => store.get(ns)?.get(slug)?.body ?? null;

// Авторизации нет, поэтому предыдущую версию перед перезаписью прячем в .history/
async function backup(ns, slug, previous) {
  if (previous == null) return;
  const dir = path.join(nsDir(ns), '.history', slug);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(dir, `${stamp}.md`), previous, 'utf8');
}

async function writeText(ns, slug, body) {
  const texts = store.get(ns) || new Map();
  const previous = texts.get(slug)?.body;
  texts.set(slug, { body, updated: new Date() });
  store.set(ns, texts);

  // Дубль на диск. Если не получилось — отдаём 500: иначе текст исчезнет при рестарте.
  await fs.mkdir(nsDir(ns), { recursive: true });
  await backup(ns, slug, previous);
  await fs.writeFile(textFile(ns, slug), body, 'utf8');
}

// Раздел целиком: сносим папку насовсем, вместе с .history — восстановить нельзя
async function deleteNamespace(ns) {
  store.delete(ns);
  await fs.rm(nsDir(ns), { recursive: true, force: true });
}

async function deleteText(ns, slug) {
  const texts = store.get(ns);
  const previous = texts?.get(slug)?.body;
  texts?.delete(slug);
  await backup(ns, slug, previous);
  await fs.rm(textFile(ns, slug), { force: true });
}

/* ---------- http ---------- */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const wantsHtml = (req) => (req.headers.accept || '').includes('text/html');

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const sendText = (res, status, body) => send(res, status, 'text/plain; charset=utf-8', body);

function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const isForm = (req) => (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');

// Из браузера приходит форма, из curl --data-binary — сырой текст
async function readBody(req) {
  const raw = await readRaw(req);
  return isForm(req) ? new URLSearchParams(raw) : new URLSearchParams([['body', raw]]);
}

/* ---------- вёрстка ---------- */

const CSS = `
:root {
  /* Тёплая почти белая база: топлёное молоко. Тёмной темы нет — текст всегда чёрный. */
  color-scheme: light;
  --bg: #faf5ea;
  --panel: #fffdf7;
  --raise: #f2e9d6;
  --line: #e2d5bb;
  --fg: #000;
  --muted: #6e6353;
  --accent: #e9cd92;
  --accent-hover: #ddb86a;
  --accent-line: #c8a45f;
  --danger: #e0a183;
  --danger-hover: #d28a68;
  --danger-line: #bd7350;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 760px; margin: 0 auto; }
/* Ссылки тоже чёрные — различаются подчёркиванием тёплого тона */
a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--accent-line);
  text-underline-offset: 2px; }
a:hover { text-decoration-color: var(--fg); }
h1 { font-size: 20px; margin: 0 0 4px; }
h1 a { text-decoration: none; }
h1 a:hover { text-decoration: underline; text-decoration-color: var(--accent-line); }
.sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 16px 0 6px; }
input, textarea { width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--fg); font-size: 14px; font-family: inherit; }
input::placeholder, textarea::placeholder { color: #a1947e; }
textarea { min-height: 380px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.5; }
button { margin-top: 20px; padding: 9px 18px; border: 1px solid var(--accent-line); border-radius: 8px;
  background: var(--accent); color: var(--fg); font-size: 14px; font-family: inherit; cursor: pointer; }
button:hover { background: var(--accent-hover); }
button.ghost { background: transparent; border-color: var(--line); color: var(--muted); }
button.ghost:hover { background: var(--raise); color: var(--fg); }
button.danger { background: var(--danger); border-color: var(--danger-line); }
button.danger:hover { background: var(--danger-hover); }
/* Кнопка-иконка справа в списке */
button.icon { margin: 0; padding: 5px 7px; line-height: 0; background: transparent; border-color: transparent;
  color: var(--muted); border-radius: 7px; }
button.icon:hover { background: var(--raise); border-color: var(--line); color: #8f3d20; }
:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 2px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
form.inline { display: inline; margin: 0; }
ul.list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
ul.list li { border-bottom: 1px solid var(--line); padding: 10px 2px; display: flex;
  align-items: center; justify-content: space-between; gap: 12px; }
ul.list .right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
ul.list .meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
pre { border: 1px solid var(--line); border-radius: 8px; padding: 14px; overflow-x: auto; background: var(--panel);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
code.url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); word-break: break-all; }
.empty { color: var(--muted); padding: 24px 0; }
dialog { border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--fg);
  padding: 22px 24px; max-width: 420px; box-shadow: 0 12px 32px rgba(80, 60, 25, 0.18); }
dialog::backdrop { background: rgba(60, 45, 20, 0.35); }
dialog p { margin: 0; font-size: 15px; }
dialog .row { margin-top: 18px; }
dialog button { margin-top: 0; }
`;

// Иконка мусорного бака: инлайн-SVG, чтобы не тянуть шрифты и картинки
const TRASH = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
  stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2.6 4.1h10.8M6.1 4.1V2.7h3.8v1.4M4.1 4.1l.6 9.1a1.1 1.1 0 0 0 1.1 1.05h4.4a1.1 1.1 0 0 0 1.1-1.05l.6-9.1"/>
  <path d="M6.7 6.9v4.8M9.3 6.9v4.8"/>
</svg>`;

const layout = (title, body) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;

const fmtDate = (d) =>
  new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(d);

const fmtSize = (n) => (n < 1024 ? `${n} Б` : `${Math.round(n / 1024)} КБ`);

const crumbs = (ns, slug) =>
  `<h1><a href="${BASE}/">textbin</a> / <a href="${BASE}/${esc(ns)}/">${esc(ns)}</a>${slug ? ` / ${esc(slug)}` : ''}</h1>`;

function homePage(namespaces) {
  const rows = namespaces
    .map(
      (ns) => `<li><a href="${BASE}/${esc(ns)}/">/${esc(ns)}/</a>
        <span class="right">
          <button type="button" class="icon" aria-label="Удалить раздел ${esc(ns)}"
                  onclick="document.getElementById('del-${esc(ns)}').showModal()">${TRASH}</button>
        </span>
        <dialog id="del-${esc(ns)}">
          <p>Ты точно хочешь удалить раздел целиком?</p>
          <div class="row">
            <form method="post" action="${BASE}/${esc(ns)}/" class="inline">
              <input type="hidden" name="action" value="delete">
              <button type="submit" class="danger">Удалить</button>
            </form>
            <form method="dialog" class="inline"><button type="submit" class="ghost">Отмена</button></form>
          </div>
        </dialog></li>`,
    )
    .join('');
  const list = namespaces.length ? `<label>Разделы</label><ul class="list">${rows}</ul>` : '';
  return layout(
    'textbin',
    `<h1>textbin</h1>
     <p class="sub">Заливаешь текст — получаешь URL. Без авторизации.</p>
     <form method="post" action="${BASE}/">
       <label for="ns">Новый раздел</label>
       <input id="ns" name="ns" autofocus pattern="[a-z0-9][a-z0-9-]{0,31}" required>
       <button type="submit">Открыть</button>
     </form>
     ${list}`,
  );
}

function listPage(ns, items) {
  const list = items.length
    ? `<ul class="list">${items
        .map(
          (it) => `<li><a href="${BASE}/${esc(ns)}/${esc(it.slug)}">${esc(it.slug)}</a>
            <span class="right">
              <span class="meta">${fmtSize(it.size)} · ${fmtDate(it.updated)}</span>
              <form method="post" action="${BASE}/${esc(ns)}/${esc(it.slug)}" class="inline">
                <input type="hidden" name="action" value="delete">
                <button type="submit" class="icon" aria-label="Удалить ${esc(it.slug)}">${TRASH}</button>
              </form>
            </span></li>`,
        )
        .join('')}</ul>`
    : '<p class="empty">Пока пусто.</p>';
  return layout(
    `/${ns}/`,
    `<h1><a href="${BASE}/">textbin</a> / ${esc(ns)}</h1>
     <p class="sub">${items.length ? `Текстов: ${items.length}` : 'Ни одного текста'}</p>
     ${list}
     <form method="get" action="${BASE}/${esc(ns)}/new"><button type="submit">СОЗДАТЬ</button></form>`,
  );
}

function editForm(ns, { slug = '', body = '', isNew }) {
  const action = isNew ? `${BASE}/${esc(ns)}/` : `${BASE}/${esc(ns)}/${esc(slug)}`;
  const slugField = isNew
    ? `<label for="slug">path</label>
       <input id="slug" name="slug" value="${esc(slug)}" placeholder="update-tokens-ui-kit"
              pattern="[a-z0-9][a-z0-9._-]{0,63}" required ${slug ? '' : 'autofocus'}>`
    : `<p class="sub"><code class="url">${BASE}/${esc(ns)}/${esc(slug)}</code></p>`;
  const remove = isNew
    ? ''
    : `<form method="post" action="${action}" style="margin-top:20px">
         <input type="hidden" name="action" value="delete">
         <button type="submit" class="ghost">Удалить</button>
       </form>`;
  return `<form method="post" action="${action}">
       ${slugField}
       <label for="body">Текст</label>
       <textarea id="body" name="body" ${isNew && !slug ? '' : 'autofocus'}>${esc(body)}</textarea>
       <div class="row">
         <button type="submit">Сохранить</button>
         <a href="${isNew ? `${BASE}/${esc(ns)}/` : action}">Отмена</a>
       </div>
     </form>
     ${remove}`;
}

function editPage(ns, opts) {
  const { slug, isNew } = opts;
  return layout(
    isNew ? `Новый текст в /${ns}/` : `Правка /${ns}/${slug}`,
    `${crumbs(ns, isNew ? '' : slug)}
     ${editForm(ns, opts)}`,
  );
}

function viewPage(ns, slug, body, host) {
  return layout(
    `${ns}/${slug}`,
    `${crumbs(ns, slug)}
     <p class="sub"><code class="url">curl ${esc(host)}${BASE}/${esc(ns)}/${esc(slug)}</code></p>
     <div class="row">
       <a href="${BASE}/${esc(ns)}/${esc(slug)}/edit">Редактировать</a>
       <a href="${BASE}/${esc(ns)}/${esc(slug)}/raw">raw</a>
     </div>
     <pre>${esc(body)}</pre>`,
  );
}

function notFoundPage(ns, slug) {
  return layout(
    `${ns}/${slug} — нет такого текста`,
    `${crumbs(ns, slug)}
     <p class="sub">Такого текста нет — можно создать его прямо сейчас.</p>
     ${editForm(ns, { slug, isNew: true })}`,
  );
}

/* ---------- маршруты ---------- */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const host = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `localhost:${PORT}`}`;

  // Проба живости отвечает и с префиксом, и без — так удобнее мониторингу
  if (url.pathname === '/healthz' || url.pathname === `${BASE}/healthz`) return sendText(res, 200, 'ok\n');

  let pathname = url.pathname;
  if (BASE) {
    if (pathname === BASE) return redirect(res, `${BASE}/`);
    if (!pathname.startsWith(`${BASE}/`)) return sendText(res, 404, 'Не найдено\n');
    pathname = pathname.slice(BASE.length);
  }

  let parts;
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return sendText(res, 400, 'Битый URL\n');
  }

  if (parts.length === 1 && (parts[0] === 'favicon.ico' || parts[0] === 'robots.txt')) {
    return sendText(res, 404, '');
  }

  /* / */
  if (parts.length === 0) {
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', homePage(listNamespaces()));
    if (req.method === 'POST') {
      const form = await readBody(req);
      const ns = (form.get('ns') || '').trim().toLowerCase();
      if (!NS_RE.test(ns)) return sendText(res, 400, 'Раздел: a-z, 0-9, дефис, до 32 символов\n');
      return redirect(res, `${BASE}/${ns}/`);
    }
    return sendText(res, 405, 'Method not allowed\n');
  }

  const ns = parts[0].toLowerCase();
  if (!NS_RE.test(ns)) return sendText(res, 400, 'Раздел: a-z, 0-9, дефис, до 32 символов\n');

  /* /<ns>/ */
  if (parts.length === 1) {
    if (req.method === 'GET') {
      if (!pathname.endsWith('/')) return redirect(res, `${BASE}/${ns}/`);
      return send(res, 200, 'text/html; charset=utf-8', listPage(ns, listTexts(ns)));
    }
    if (req.method === 'POST') {
      const form = await readBody(req);
      if (form.get('action') === 'delete') {
        await deleteNamespace(ns);
        return redirect(res, `${BASE}/`);
      }
      const slug = (form.get('slug') || '').trim().toLowerCase();
      if (!SLUG_RE.test(slug) || RESERVED.has(slug)) {
        return sendText(res, 400, 'path: a-z, 0-9, точка, дефис, подчёркивание, до 64 символов\n');
      }
      await writeText(ns, slug, form.get('body') ?? '');
      return redirect(res, `${BASE}/${ns}/${slug}`);
    }
    return sendText(res, 405, 'Method not allowed\n');
  }

  const slug = parts[1].toLowerCase();

  /* /<ns>/new */
  if (parts.length === 2 && slug === 'new' && req.method === 'GET') {
    return send(res, 200, 'text/html; charset=utf-8', editPage(ns, { isNew: true }));
  }

  if (!SLUG_RE.test(slug)) return sendText(res, 400, 'Неверный path\n');

  /* /<ns>/<slug> */
  if (parts.length === 2) {
    if (req.method === 'GET') {
      const body = readText(ns, slug);
      if (body === null) {
        return wantsHtml(req)
          ? send(res, 404, 'text/html; charset=utf-8', notFoundPage(ns, slug))
          : sendText(res, 404, 'Нет такого текста\n');
      }
      return wantsHtml(req)
        ? send(res, 200, 'text/html; charset=utf-8', viewPage(ns, slug, body, host))
        : sendText(res, 200, body);
    }
    if (req.method === 'POST') {
      const form = await readBody(req);
      if (form.get('action') === 'delete') {
        await deleteText(ns, slug);
        return redirect(res, `${BASE}/${ns}/`);
      }
      await writeText(ns, slug, form.get('body') ?? '');
      return redirect(res, `${BASE}/${ns}/${slug}`);
    }
    if (req.method === 'PUT') {
      if (RESERVED.has(slug)) return sendText(res, 400, 'Зарезервированный path\n');
      await writeText(ns, slug, await readRaw(req));
      return sendText(res, 200, `${host}${BASE}/${ns}/${slug}\n`);
    }
    return sendText(res, 405, 'Method not allowed\n');
  }

  /* /<ns>/<slug>/raw | /<ns>/<slug>/edit */
  if (parts.length === 3 && req.method === 'GET') {
    const body = readText(ns, slug);
    if (parts[2] === 'raw') {
      return body === null ? sendText(res, 404, 'Нет такого текста\n') : sendText(res, 200, body);
    }
    if (parts[2] === 'edit') {
      return send(
        res,
        200,
        'text/html; charset=utf-8',
        body === null ? editPage(ns, { slug, isNew: true }) : editPage(ns, { slug, body, isNew: false }),
      );
    }
  }

  return wantsHtml(req)
    ? send(
        res,
        404,
        'text/html; charset=utf-8',
        layout('404', `<h1><a href="${BASE}/">textbin</a></h1><p class="sub">Страница не найдена.</p>`),
      )
    : sendText(res, 404, 'Не найдено\n');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err && err.tooLarge) return sendText(res, 413, 'Слишком большой текст (лимит 2 МБ)\n');
    console.error(`${req.method} ${req.url} ->`, err);
    if (!res.headersSent) sendText(res, 500, 'Внутренняя ошибка\n');
  });
});

fs.mkdir(DATA_DIR, { recursive: true })
  .then(loadFromDisk)
  .then((total) => {
    server.listen(PORT, HOST, () => {
      console.log(`textbin: http://localhost:${PORT}${BASE || ''}`);
      console.log(`данные: ${DATA_DIR} (загружено текстов: ${total})`);
    });
  })
  .catch((err) => {
    console.error('не удалось прочитать каталог данных:', err);
    process.exit(1);
  });
