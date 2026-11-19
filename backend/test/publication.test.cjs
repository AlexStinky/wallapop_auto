const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Use an isolated database even when run from a configured application checkout.
test('product API, publication queues and uploads', { timeout: 30000 }, async t => {
  const url = new URL(process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017');
  url.pathname = '/wallapop_test_' + randomUUID().replaceAll('-', '');
  process.env.DATABASE_URL = url.toString();
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'wallapop-photos-'));
  process.env.UPLOAD_DIR = uploadDir;
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const db = require('../dist/db/prisma').default;
  t.after(async () => {
    try { await db.$runCommandRaw({ dropDatabase: 1 }); }
    finally { await db.$disconnect(); }
  });

  const express = require('express');
  const products = require('../dist/routes/products').default;
  const { errorHandler } = require('../dist/middleware/error');
  const { browserService } = require('../dist/services/browser.service');
  const { vintedBrowserService } = require('../dist/services/vinted.service');
  const { queueService, queueEvents } = require('../dist/services/queue.service');
  const { setPublicationState } = require('../dist/services/publication-state');
  const { resolveUploadedPhoto } = require('../dist/uploads');
  const app = express().use(express.json()).use('/products', products).use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/products';
  const post = (route, data) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  async function draft(title, overrides = {}) {
    const response = await post('', { title, description: 'test', condition: 'new', price: 1, ...overrides });
    assert.equal(response.status, 201);
    return response.json();
  }
  for (const browser of [browserService, vintedBrowserService]) {
    t.mock.method(browser, 'initialize', async () => {});
    t.mock.method(browser, 'isLoggedIn', async () => true);
    t.mock.method(browser, 'close', async () => {});
  }
  await db.settings.create({ data: { publishDelay: 0 } });

  await t.test('handles validation and serves only supported photo references', async () => {
    assert.equal((await fetch(base + '/bad-id')).status, 400);
    const upload = new FormData();
    upload.append('images', new Blob(['test'], { type: 'image/jpeg' }), 'photo.txt');
    const response = await fetch(base + '/upload', { method: 'POST', body: upload });
    assert.equal(response.status, 200);
    const { urls } = await response.json();
    assert.match(urls[0], /^uploads\/.+\.jpg$/);
    assert.equal(resolveUploadedPhoto(urls[0]), path.join(process.env.UPLOAD_DIR, path.basename(urls[0])));
    assert.equal(resolveUploadedPhoto('missing.jpg'), null);
    const unsupported = new FormData();
    unsupported.append('images', new Blob(['test'], { type: 'text/plain' }), 'photo.jpg');
    assert.equal((await fetch(base + '/upload', { method: 'POST', body: unsupported })).status, 415);
  });

  await t.test('keeps the next item when an older product is queued during publication', async () => {
    const older = await draft('older', { publishToVinted: false });
    const first = await draft('first', { publishToVinted: false });
    let entered, resume;
    const started = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { resume = resolve; });
    const calls = [];
    const browser = t.mock.method(browserService, 'publishProduct', async product => {
      calls.push(product.id);
      if (product.id === first.id) { entered(); await paused; }
      return { success: true };
    });
    const vinted = t.mock.method(vintedBrowserService, 'publishProduct', async () => ({ success: true }));
    await queueService.addToQueue(first.id);
    const finished = new Promise(resolve => {
      function observe(state) {
        if (!state.isRunning && !state.items.length) { queueEvents.off('state', observe); resolve(); }
      }
      queueEvents.on('state', observe);
    });
    await queueService.startProcessing();
    await started;
    try {
      await queueService.addToQueue(older.id);
      assert.equal((await post('/' + first.id + '/publish-now', { platform: 'wallapop' })).status, 200);
    } finally { resume(); }
    await finished;
    assert.deepEqual(calls, [first.id, older.id]);
    assert.equal(vinted.mock.callCount(), 0);
    browser.mock.restore();
    vinted.mock.restore();
  });

  await t.test('publishes each platform once and retains the failing platform result', async () => {
    const item = await draft('both');
    const wp = t.mock.method(browserService, 'publishProduct', async () => ({ success: true, wallapopId: 'test' }));
    const vi = t.mock.method(vintedBrowserService, 'publishProduct', async () => ({ success: false, error: 'test error' }));
    assert.equal((await post('/publish-all', {})).status, 200);
    let product;
    for (let i = 0; i < 100; i++) {
      product = await db.product.findUniqueOrThrow({ where: { id: item.id } });
      if (product.wallapopStatus === 'published' && product.vintedStatus === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(wp.mock.callCount(), 1);
    assert.equal(vi.mock.callCount(), 1);
    assert.equal(product.wallapopStatus, 'published');
    assert.equal(product.vintedStatus, 'error');
    assert.equal(product.status, 'error');
    assert.match(product.errorMessage, /test error/);
    await Promise.all(['vinted', 'wallapop'].map(platform => setPublicationState(item.id, platform, 'published')));
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: item.id } })).status, 'published');
  });
});

test('Vinted repairs skipped fields after form validation', { timeout: 20000 }, async t => {
  const { chromium } = require('playwright');
  const { VintedBrowserService } = require('../dist/services/vinted.service');
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch()).catch(error => {
    if (!String(error).includes("Executable doesn't exist")) throw error;
    return null;
  });
  if (!browser) {
    t.skip('Chromium is unavailable');
    return;
  }
  t.after(() => browser.close());

  async function publish(canSelectCategory) {
    const page = await browser.newPage();
    const service = new VintedBrowserService();
    service.page = page;
    t.mock.method(service, 'acceptCookies', async () => {});
    t.mock.method(service, 'randomDelay', async () => {});
    t.mock.method(page, 'waitForTimeout', async () => {});

    await page.route('**/*', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: new URL(route.request().url()).pathname === '/items/new' ? `
        <form>
          <input id="title">
          <textarea id="description"></textarea>
          <div>
            <button type="button" data-testid="catalog-suggestion" aria-pressed="true">Ropa</button>
          </div>
          <ul><li>
            <div class="m4PZBq_input-dropdown">
              <label for="category">Categoría</label>
              <div class="m4PZBq_input-dropdown__content">
                <input id="category" name="category" data-testid="catalog-select-dropdown-input"
                  readonly placeholder="Elige una categoría" value="">
              </div>
              <div id="category-note" class="m4PZBq_input-dropdown__note"></div>
            </div>
          </li></ul>
          <div id="format-field" hidden>
            <input data-testid="format-dropdown-input" id="format" readonly>
            <div id="format-note"></div>
          </div>
          <div><input id="price"><div id="price-note"></div></div>
          <input id="untouched" value="Original">
          <button type="button" data-testid="upload-form-save-button">Subir</button>
        </form>
        <div id="menu" data-testid="catalog-select-dropdown-content" hidden></div>
        <script>
          const byId = id => document.getElementById(id);
          const category = byId('category');
          const format = byId('format');
          const price = byId('price');
          const menu = byId('menu');
          let submissions = 0;
          const warning = (id, message) => {
            byId(id).innerHTML = message
              ? '<div class="web_ui__Validation__validation web_ui__Validation__warning" role="alert">' + message + '</div>'
              : '';
          };

          category.onclick = () => {
            menu.hidden = false;
            menu.innerHTML = submissions && ${canSelectCategory}
              ? '<input type="search" placeholder="Buscar"><button tabindex="0">Hogar</button>'
              : '<p>Sin opciones</p>';
            const root = menu.querySelector('button');
            if (!root) return;
            root.onclick = () => {
              category.value = root.textContent;
              menu.innerHTML = '<button role="radio">Otro</button><button role="radio">Decoración</button>';
              for (const leaf of menu.querySelectorAll('button')) {
                leaf.onclick = () => {
                  category.value = leaf.textContent;
                  warning('category-note', '');
                  byId('format-field').hidden = false;
                  menu.hidden = true;
                };
              }
            };
          };
          format.onclick = () => {
            menu.hidden = false;
            menu.setAttribute('role', 'listbox');
            menu.innerHTML = '<button role="option">Mediano</button>';
            menu.querySelector('button').onclick = () => {
              format.value = 'Mediano';
              warning('format-note', '');
              menu.hidden = true;
            };
          };
          document.addEventListener('keydown', event => {
            if (event.key === 'Escape') menu.hidden = true;
          });
          document.querySelector('[data-testid="upload-form-save-button"]').onclick = () => {
            submissions++;
            if (!category.value) {
              warning('category-note', 'Elige una subcategoría');
            } else if (!format.value) {
              price.value = '';
              warning('format-note', 'Selecciona un formato');
              warning('price-note', 'Introduce un precio');
            }
            sessionStorage.setItem('form', JSON.stringify({
              submissions, category: category.value, format: format.value,
              price: price.value, untouched: byId('untouched').value,
            }));
            if (category.value && format.value && price.value) location.assign('/items/12345-marco');
          };
        </script>
      ` : '<p>Published</p>',
    }));

    const result = await service.publishProduct({
      id: 'validation-test',
      title: 'Marco',
      description: 'Marco de madera',
      price: 15.5,
      category: 'Hogar',
      subcategory: 'Decoracion',
      images: '[]',
    });
    const form = await page.evaluate(() => JSON.parse(sessionStorage.getItem('form')));
    return { result, form };
  }

  const recovered = await publish(true);
  assert.deepEqual(recovered.result, {
    success: true,
    vintedId: '12345',
    url: 'https://www.vinted.es/items/12345-marco',
  });
  assert.deepEqual(recovered.form, {
    submissions: 3, category: 'Decoración', format: 'Mediano', price: '15,5', untouched: 'Original',
  });

  const blocked = await publish(false);
  assert.equal(blocked.result.success, false);
  assert.match(blocked.result.error, /Elige una subcategoría/);
  assert.equal(blocked.form.submissions, 1);
});
