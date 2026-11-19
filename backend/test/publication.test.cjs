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
  const { restorePublishedProducts, setPublicationState } = require('../dist/services/publication-state');
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

  await t.test('reports a successful single-platform publication when the other platform is idle', async () => {
    for (const [platform, other] of [['wallapop', 'vinted'], ['vinted', 'wallapop']]) {
      const item = await draft(platform);
      await setPublicationState(item.id, platform, 'in_queue');
      await setPublicationState(item.id, platform, 'publishing');
      await setPublicationState(item.id, platform, 'published');

      const result = await fetch(base + '/' + item.id).then(response => response.json());
      assert.equal(result.status, 'published');
      assert.equal(result[platform + 'Status'], 'published');
      assert.equal(result[other + 'Status'], 'pending');
    }
  });

  await t.test('restores the status of existing publications', async () => {
    const published = await draft('published with no listing ID');
    const legacy = await draft('legacy publication');
    const queued = await draft('waiting for the other platform');
    const pending = await draft('unpublished');
    await db.product.update({ where: { id: published.id }, data: { vintedStatus: 'published' } });
    await db.product.update({ where: { id: legacy.id }, data: { wallapopId: 'legacy-id', wallapopStatus: { unset: true } } });
    await db.product.update({ where: { id: queued.id }, data: { wallapopStatus: 'published', vintedStatus: 'in_queue' } });
    await db.product.update({ where: { id: pending.id }, data: { wallapopId: '', vintedId: null } });

    await restorePublishedProducts();

    const list = await fetch(base + '?status=published').then(response => response.json());
    assert.ok(list.some(item => item.id === published.id));
    assert.ok(list.some(item => item.id === legacy.id));
    assert.ok(!list.some(item => item.id === queued.id));
    assert.ok(!list.some(item => item.id === pending.id));
  });
});

async function launchVintedBrowser(t) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch()).catch(error => {
    if (!String(error).includes("Executable doesn't exist")) throw error;
    return null;
  });
  if (!browser) {
    t.skip('Chromium is unavailable');
    return;
  }
  t.after(() => browser.close());
  return browser;
}

test('Vinted repairs skipped fields after form validation', { timeout: 30000 }, async t => {
  const { VintedBrowserService } = require('../dist/services/vinted.service');
  const browser = await launchVintedBrowser(t);
  if (!browser) return;

  async function publish(canSelectCategory, brandAvailable = true, vintedTitle) {
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
          <input id="site-search" placeholder="Buscar artículos">
          <div><input id="title"><div id="title-note"></div></div>
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
          <input data-testid="brand-select-dropdown-input" hidden>
          <div id="brand-field" hidden>
            <input id="brand" data-testid="brand-select-dropdown-input" aria-controls="brand-menu" readonly>
            <div id="brand-note"></div>
          </div>
          <div><input id="price"><div id="price-note"></div></div>
          <input id="untouched" value="Original">
          <button type="button" data-testid="upload-form-save-button">Subir</button>
        </form>
        <div id="menu" data-testid="catalog-select-dropdown-content" hidden></div>
        <div id="brand-menu" data-radix-popper-content-wrapper hidden>
          <input type="search" placeholder="Buscar una marca" hidden>
          <input type="search" readonly>
          <input id="brand-search" type="search" placeholder="Buscar una marca" hidden>
          <button role="option" hidden>Winfaith</button>
          <div id="brand-results" role="listbox"></div>
        </div>
        <script>
          const byId = id => document.getElementById(id);
          const title = byId('title');
          const category = byId('category');
          const format = byId('format');
          const price = byId('price');
          const menu = byId('menu');
          const brand = byId('brand');
          const brandMenu = byId('brand-menu');
          const brandSearch = byId('brand-search');
          const brandSearches = [];
          let submissions = 0;
          let firstTitle;
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
          brand.onclick = () => {
            brandMenu.hidden = false;
            setTimeout(() => { brandSearch.hidden = false; }, 75);
          };
          brandSearch.oninput = () => {
            const query = brandSearch.value;
            brandSearches.push(query);
            const results = byId('brand-results');
            results.replaceChildren();
            setTimeout(() => {
              const labels = query === 'Sin marca' ? ['Sin marca']
                : query === 'Winfaith' && ${brandAvailable} ? ['Winfaith Plus', 'Winfaith'] : [];
              for (const label of labels) {
                const result = document.createElement('button');
                result.setAttribute('role', 'option');
                if (label === labels[0]) result.setAttribute('aria-selected', 'true');
                result.textContent = label;
                result.onclick = () => {
                  brand.value = label;
                  warning('brand-note', '');
                  brandMenu.hidden = true;
                };
                results.append(result);
              }
            }, 75);
          };
          document.addEventListener('keydown', event => {
            if (event.key === 'Escape') menu.hidden = true;
          });
          document.querySelector('[data-testid="upload-form-save-button"]').onclick = () => {
            submissions++;
            if (submissions === 1) firstTitle = title.value;
            if (!category.value) {
              warning('category-note', 'Elige una subcategoría');
            } else if (!format.value || !brand.value) {
              title.value = '';
              price.value = '';
              byId('brand-field').hidden = false;
              warning('brand-note', 'Selecciona una marca');
              warning('format-note', 'Selecciona un formato');
              warning('title-note', 'Introduce un título');
              warning('price-note', 'Introduce un precio');
            }
            sessionStorage.setItem('form', JSON.stringify({
              submissions, category: category.value, format: format.value,
              price: price.value, untouched: byId('untouched').value,
              brand: brand.value, brandSearches, siteSearch: byId('site-search').value,
              firstTitle, title: title.value,
            }));
            if (category.value && format.value && title.value && price.value && brand.value) location.assign('/items/12345-marco');
          };
        </script>
      ` : '<p>Published</p>',
    }));

    const result = await service.publishProduct({
      id: 'validation-test',
      title: '  MARCO de pared XL para ÁLBUM  ',
      vintedTitle,
      description: 'Marco de madera',
      price: 15.5,
      category: 'Hogar',
      subcategory: 'Decoracion',
      brand: 'Winfaith',
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
    brand: 'Winfaith', brandSearches: ['Winfaith'], siteSearch: '',
    firstTitle: 'MArco de pared XL para ÁLbum', title: 'MArco de pared XL para ÁLbum',
  });

  const unbranded = await publish(true, false, '  Marco LIJADO  ');
  assert.equal(unbranded.result.success, true);
  assert.equal(unbranded.form.brand, 'Sin marca');
  assert.deepEqual(unbranded.form.brandSearches, ['Winfaith', 'Sin marca']);
  assert.equal(unbranded.form.siteSearch, '');
  assert.equal(unbranded.form.firstTitle, 'Marco LIjado');
  assert.equal(unbranded.form.title, 'Marco LIjado');

  const blocked = await publish(false);
  assert.equal(blocked.result.success, false);
  assert.match(blocked.result.error, /Elige una subcategoría/);
  assert.equal(blocked.form.submissions, 1);
});

test('Vinted closes Estado and moves on to the remaining details', { timeout: 20000 }, async t => {
  const { VintedBrowserService } = require('../dist/services/vinted.service');
  const browser = await launchVintedBrowser(t);
  if (!browser) return;

  const fields = [
    ['brand', 'brand-select-dropdown-input', 'Marca', 'Genérica', 'Winfaith'],
    ['condition', 'category-condition-single-list-input', 'Estado', 'Nuevo con etiquetas', 'Nuevo sin etiquetas'],
    ['color', 'color-select-dropdown-input', 'Color', 'Negro', 'Plata'],
    ['material', 'category-material-multi-list-input', 'Material', 'Madera', 'Acero'],
  ];
  for (const blockedCondition of [false, true]) {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        [hidden] { display: none; }
        #backdrop { position: fixed; inset: 0; z-index: 1; }
        .choices { position: relative; z-index: 2; background: white; }
        .blocked { pointer-events: none; }
      </style>
      <input hidden data-testid="category-condition-single-list-input">
      <ul>
        ${fields.map(([name, testId, label, first, second]) => `
          <li>
            <div class="m4PZBq_input-dropdown">
              <label for="${name}" class="m4PZBq_input-dropdown__title">${label}</label>
              <div class="m4PZBq_input-dropdown__content">
                <input id="${name}" name="${name}" data-testid="${testId}" readonly>
              </div>
              <div class="m4PZBq_input-dropdown__note"></div>
              <div hidden class="choices ${name === 'condition' && blockedCondition ? 'blocked' : ''}">
                ${name === 'brand' ? '<input type="search">' : ''}
                <button role="option" disabled>No disponible</button>
                <button role="option">${first}</button>
                <button role="option">${second}</button>
              </div>
            </div>
          </li>
        `).join('')}
      </ul>
      <div id="backdrop" hidden></div>
      <script>
        const backdrop = document.querySelector('#backdrop');
        let openMenu;
        for (const field of document.querySelectorAll('input[readonly]')) {
          const menu = field.closest('li').querySelector('.choices');
          field.onclick = () => {
            openMenu = menu;
            menu.hidden = false;
            backdrop.hidden = false;
          };
          for (const option of menu.querySelectorAll('button:not(:disabled)')) {
            option.onclick = () => {
              field.value = option.textContent;
              option.setAttribute('aria-selected', 'true');
            };
          }
        }
        document.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || !openMenu) return;
          openMenu.hidden = true;
          backdrop.hidden = true;
          openMenu = null;
        });
      </script>
    `);
    const service = new VintedBrowserService();
    service.page = page;
    await service.fillProductDetails({ brand: 'Winfaith', color: 'Plata', material: 'Acero' });

    const values = await page.locator('li input[readonly]').evaluateAll(fields => fields.map(field => field.value));
    assert.deepEqual(values, ['Winfaith', blockedCondition ? '' : 'Nuevo sin etiquetas', 'Plata', 'Acero']);
    assert.equal(await page.locator('#backdrop').isVisible(), false);
    await page.close();
  }
});

test('Vinted preserves choices already made by the form', { timeout: 15000 }, async t => {
  const { VintedBrowserService } = require('../dist/services/vinted.service');
  const browser = await launchVintedBrowser(t);
  if (!browser) return;

  const page = await browser.newPage();
  await page.setContent(`
    <div>
      <input id="category" readonly value="Hogar">
      <div role="alert">Revisa la categoría</div>
    </div>
    <input id="brand" readonly value="Marca del sitio">
    <select id="condition">
      <option value="">Selecciona un estado</option>
      <option value="new" selected>Nuevo con etiquetas</option>
      <option value="good">En muy buen estado</option>
    </select>
    <ul>
      <li>
        <input id="size" readonly placeholder="Elige la talla">
        <div id="size-menu" class="dropdown__content" hidden>
          <button role="radio" aria-checked="true">S</button>
          <button id="other-size" role="radio" aria-label="L">L</button>
        </div>
      </li>
      <li>
        <input id="color" readonly placeholder="Selecciona un color">
        <div id="color-menu" hidden>
          <label><input type="checkbox" checked> Plata</label>
          <button id="other-color" role="checkbox">Negro</button>
        </div>
      </li>
    </ul>
    <button id="material" data-value="Madera">Madera</button>
    <div>
      <input id="format" readonly value="Mediano">
      <div role="alert">Selecciona un formato</div>
    </div>
    <label id="package-size-1" for="package_type_selector_1">
      Recomendado
      <input type="radio" id="package_type_selector_1" name="package_size">
    </label>
    <label id="package-size-2" for="package_type_selector_2">
      Mediano
      <input type="radio" id="package_type_selector_2" name="package_size" checked>
    </label>
    <div role="alert">Selecciona el tamaño del paquete</div>
    <script>
      window.replacements = [];
      for (const id of ['category', 'brand', 'material', 'format', 'other-color', 'other-size', 'package-size-1']) {
        document.getElementById(id).onclick = () => replacements.push(id);
      }
      for (const id of ['size', 'color']) {
        document.getElementById(id).onclick = () => document.getElementById(id + '-menu').hidden = false;
      }
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          document.getElementById('size-menu').hidden = true;
          document.getElementById('color-menu').hidden = true;
        }
      });
    </script>
  `);
  const service = new VintedBrowserService();
  service.page = page;
  const product = { category: 'Mujer', brand: 'Otra marca', vintedSize: 'L', color: 'Negro', material: 'Acero' };
  assert.equal(await service.selectCategory(product.category), true);
  await service.fillProductDetails(product);
  assert.equal(await service.handlePackageSize(), false);
  assert.equal(await service.repairValidationErrors(product, page.getByRole('alert'), new Set()), false);

  assert.equal(await page.locator('#condition').inputValue(), 'new');
  assert.equal(await page.locator('#package_type_selector_2').isChecked(), true);
  assert.equal(await page.locator('#color-menu input').isChecked(), true);
  assert.equal(await page.locator('#size-menu [aria-checked]').getAttribute('aria-checked'), 'true');
  assert.deepEqual(await page.evaluate(() => window.replacements), []);

  await page.setContent(`
    <input id="category" readonly value="Hogar">
    <div id="warning" role="alert">Elige una subcategoría</div>
    <button aria-pressed="true" data-testid="category-suggestion">Mujer</button>
    <div data-testid="catalog-select-dropdown-content" hidden id="category-menu">
      <button>Mujer</button>
      <button id="home">Hogar</button>
    </div>
    <script>
      const category = document.querySelector('#category');
      const menu = document.querySelector('#category-menu');
      category.onclick = () => { menu.hidden = false; };
      document.querySelector('#home').onclick = () => {
        menu.innerHTML = '<button role="radio">Decoración</button>';
        menu.firstChild.onclick = () => {
          category.value = 'Hogar > Decoración';
          document.querySelector('#warning').remove();
          menu.hidden = true;
        };
      };
    </script>
  `);
  assert.equal(await service.selectCategory('Mujer', 'Decoración', true), true);
  assert.equal(await page.locator('#category').inputValue(), 'Hogar > Decoración');
});
