import { Browser, BrowserContext, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Product } from '@prisma/client';
import { PublishResult } from '../types';

const COOKIES_PATH = path.join(process.cwd(), '.vinted-cookies.json');
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class VintedBrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isHeadless = true;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(headless: boolean): Promise<void> {
    if (this.browser) {
      await this.close();
    }

    this.isHeadless = headless;

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      ...(headless ? [] : ['--start-maximized']),
    ];

    try {
      this.browser = await chromium.launch({
        headless,
        channel: 'chrome',
        args: launchArgs,
        ignoreDefaultArgs: ['--enable-automation'],
      });
    } catch (_) {
      this.browser = await chromium.launch({
        headless,
        args: launchArgs,
        ignoreDefaultArgs: ['--enable-automation'],
      });
    }

    this.context = await this.browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: headless ? { width: 1280, height: 800 } : null,
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      storageState: fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : undefined,
    });

    // Ensure session cookies from vinted.com also apply to vinted.es and vice versa
    if (fs.existsSync(COOKIES_PATH)) {
      try {
        const rawData = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        const cookiesList: any[] = rawData.cookies || [];
        const extraCookies: any[] = [];
        for (const c of cookiesList) {
          if (c.domain && c.domain.includes('vinted.com')) {
            extraCookies.push({ ...c, domain: c.domain.replace('vinted.com', 'vinted.es') });
          } else if (c.domain && c.domain.includes('vinted.es')) {
            extraCookies.push({ ...c, domain: c.domain.replace('vinted.es', 'vinted.com') });
          }
        }
        if (extraCookies.length > 0) {
          await this.context.addCookies(extraCookies).catch(() => null);
        }
      } catch (_) {}
    }

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      (window as any).chrome = (window as any).chrome || {
        app: { isInstalled: false },
        runtime: {},
      };
    });

    this.page = await this.context.newPage();
    if (!headless && this.page) {
      await this.page.bringToFront().catch(() => null);
    }
    console.log('[VintedBrowser] Initialized (headless=%s, desktop)', headless);
  }

  // ─── Cookie Management & Manual Login ────────────────────────────────────────

  async importCookies(raw: string): Promise<{ success: boolean; count: number; error?: string }> {
    try {
      let cookies: any[] = [];
      let origins: any[] = [];

      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          cookies = parsed.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'vinted.es'}`,
            path: c.path || '/',
            expires: c.expirationDate ?? c.expires ?? -1,
            httpOnly: Boolean(c.httpOnly),
            secure: Boolean(c.secure),
            sameSite:
              c.sameSite === 'no_restriction'
                ? 'None'
                : c.sameSite === 'strict'
                ? 'Strict'
                : 'Lax',
          }));
        } else if (parsed.cookies && Array.isArray(parsed.cookies)) {
          cookies = parsed.cookies;
          origins = parsed.origins || [];
        }
      } else {
        const parts = trimmed.split(';');
        for (const part of parts) {
          const idx = part.indexOf('=');
          if (idx > 0) {
            const name = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (name) {
              cookies.push({
                name,
                value,
                domain: '.vinted.es',
                path: '/',
                expires: -1,
                httpOnly: false,
                secure: true,
                sameSite: 'Lax',
              });
            }
          }
        }
      }

      if (cookies.length === 0) {
        return { success: false, count: 0, error: 'Не знайдено жодного кукі у введеному тексті' };
      }

      const storageState = {
        cookies,
        origins,
      };

      fs.writeFileSync(COOKIES_PATH, JSON.stringify(storageState, null, 2), 'utf-8');
      console.log('[VintedBrowser] Imported %d cookies into %s', cookies.length, COOKIES_PATH);
      return { success: true, count: cookies.length };
    } catch (err: any) {
      console.error('[VintedBrowser] importCookies error:', err);
      return { success: false, count: 0, error: err.message || 'Помилка розбору кукі' };
    }
  }

  async openBrowserForManualLogin(maxWaitMs = 180000): Promise<{ success: boolean; message: string }> {
    try {
      if (this.browser) {
        await this.close();
      }

      console.log('[VintedBrowser] Opening browser for manual login...');
      this.isHeadless = false;

      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--start-maximized',
      ];

      try {
        this.browser = await chromium.launch({
          headless: false,
          channel: 'chrome',
          args: launchArgs,
          ignoreDefaultArgs: ['--enable-automation'],
        });
      } catch (_) {
        this.browser = await chromium.launch({
          headless: false,
          args: launchArgs,
          ignoreDefaultArgs: ['--enable-automation'],
        });
      }

      this.context = await this.browser.newContext({
        userAgent: DESKTOP_UA,
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        viewport: null,
        storageState: fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : undefined,
      });

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      });

      this.page = await this.context.newPage();
      await this.page.goto('https://www.vinted.com/member/login/email', { waitUntil: 'domcontentloaded' }).catch(() => null);
      await this.acceptCookies(this.page);

      console.log('[VintedBrowser] Waiting for user to complete manual login (max %ds)...', maxWaitMs / 1000);
      const startTime = Date.now();
      let loggedIn = false;

      while (Date.now() - startTime < maxWaitMs) {
        await this.page.waitForTimeout(3000);
        if (!this.browser || !this.page || this.page.isClosed()) {
          console.log('[VintedBrowser] Browser window closed');
          break;
        }

        const currentUrl = this.page.url();
        if (
          currentUrl.includes('vinted.') &&
          !currentUrl.includes('/member/login') &&
          !currentUrl.includes('/member/general/login') &&
          !currentUrl.includes('/auth') &&
          !currentUrl.includes('/login')
        ) {
          // Additional check for logged-in indicator
          const hasUserAvatar = await this.page.$('[data-testid="header-user-avatar"], [data-testid="header-avatar"], a[href*="/member/"]').catch(() => null);
          if (hasUserAvatar || currentUrl.includes('/items/new') || currentUrl.includes('/feed') || currentUrl.endsWith('.vinted.com/') || currentUrl.endsWith('.vinted.es/')) {
            loggedIn = true;
            console.log('[VintedBrowser] Detected successful login! URL: %s', currentUrl);
            await this.randomDelay(2000, 3000);
            break;
          }
        }
      }

      if (this.context) {
        await this.context.storageState({ path: COOKIES_PATH });
        console.log('[VintedBrowser] Saved session cookies to %s', COOKIES_PATH);
      }

      await this.close();
      return {
        success: loggedIn,
        message: loggedIn
          ? 'Авторизація на Vinted успішна! Сесія збережена.'
          : 'Браузер закрито. Якщо ви встигли авторизуватися, сесію збережено.',
      };
    } catch (err: any) {
      await this.close().catch(() => null);
      return { success: false, message: err.message || 'Помилка відкриття браузера' };
    }
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.storageState({ path: COOKIES_PATH });
      }
    } catch (_) {
      // Best effort
    }
    await this.page?.close().catch(() => null);
    await this.context?.close().catch(() => null);
    await this.browser?.close().catch(() => null);
    this.page = null;
    this.context = null;
    this.browser = null;
    console.log('[VintedBrowser] Closed');
  }

  async acceptCookies(page: Page): Promise<void> {
    try {
      const cookieBtn = await page.waitForSelector(
        '#onetrust-accept-btn-handler, button[id*="accept"], button:has-text("Aceptar todas"), button:has-text("Aceptar")',
        { timeout: 4000 }
      );
      if (cookieBtn) {
        await cookieBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (_) {
      // Cookies dialog might not appear
    }
  }

  async isLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    try {
      // Try visiting /items/new first on vinted.es, fallback to vinted.com if needed
      await this.page.goto('https://www.vinted.es/items/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.acceptCookies(this.page);
      await this.page.waitForTimeout(2000);

      let url = this.page.url();
      if (url.includes('/login') || url.includes('/member/general/login') || url.includes('/auth') || url.includes('/register')) {
        // Try on vinted.com
        await this.page.goto('https://www.vinted.com/items/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.acceptCookies(this.page);
        await this.page.waitForTimeout(2000);
        url = this.page.url();
      }

      if (url.includes('/login') || url.includes('/member/general/login') || url.includes('/auth') || url.includes('/register')) {
        return false;
      }

      // Check if title input or photo upload input is visible on /items/new
      const uploadArea = await this.page.$(
        'input[data-testid="add-photos-input"], input[type="file"], input[data-testid="title--input"], input[name="title"]'
      );
      return Boolean(uploadArea);
    } catch (err) {
      console.warn('[VintedBrowser] isLoggedIn check failed:', err);
      return false;
    }
  }

  async login(email?: string, password?: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      console.log('[VintedBrowser] Navigating to login page...');
      await this.page.goto('https://www.vinted.com/member/login/email', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.acceptCookies(this.page);
      await this.page.waitForTimeout(1500);

      if (!email || !password) {
        return false;
      }

      // Vinted often has email/password fields or a button "Continuar con el email"
      const emailLoginBtn = await this.page.$(
        'button:has-text("email"), a:has-text("email"), [data-testid="auth-select-type--email"]'
      );
      if (emailLoginBtn) {
        await emailLoginBtn.click();
        await this.page.waitForTimeout(1000);
      }

      const emailInput = await this.page.waitForSelector('input[name="username"], input[name="email"], input[type="email"]', { timeout: 5000 });
      if (emailInput) {
        await emailInput.fill(email);
        await this.randomDelay(300, 700);

        const passwordInput = await this.page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 5000 });
        if (passwordInput) {
          await passwordInput.fill(password);
          await this.randomDelay(400, 800);

          const submitBtn = await this.page.waitForSelector('button[type="submit"], button:has-text("Iniciar sesión"), button:has-text("Entrar")', { timeout: 5000 });
          if (submitBtn) {
            await submitBtn.click();
            await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
            await this.page.waitForTimeout(3000);
          }
        }
      }

      return await this.isLoggedIn();
    } catch (err) {
      console.warn('[VintedBrowser] Automatic login failed (likely captcha or antibot):', err);
      return false;
    }
  }

  // ─── Publish Flow ───────────────────────────────────────────────────────────

  async publishProduct(product: Product): Promise<PublishResult> {
    if (!this.page) {
      return { success: false, error: 'Браузер Vinted не ініціалізовано' };
    }

    try {
      console.log('[VintedPublish] Starting publication for product %s (%s)', product.id, product.title);
      await this.page.goto('https://www.vinted.es/items/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.acceptCookies(this.page);
      await this.page.waitForTimeout(2000);

      // If redirected to login/register on .es, try on .com
      if (this.page.url().includes('/login') || this.page.url().includes('/auth') || this.page.url().includes('/register')) {
        console.log('[VintedPublish] Redirected on .es (%s), attempting on .com...', this.page.url());
        await this.page.goto('https://www.vinted.com/items/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await this.acceptCookies(this.page);
        await this.page.waitForTimeout(2000);
      }

      // Check if still redirected to login
      if (this.page.url().includes('/login') || this.page.url().includes('/auth') || this.page.url().includes('/register')) {
        return { success: false, error: 'Сесія Vinted не авторизована. Виконайте вхід у Налаштуваннях.' };
      }

      // 1. Photos upload: если фоток 3 или больше — пропускаем первые две, если меньше 3 — публикуем все
      let images: string[] = [];
      try {
        images = JSON.parse(product.images || '[]');
      } catch {
        images = [];
      }

      // Если фоток меньше 3 — публикуем все, если 3 и больше — пропускаем первые две
      const vintedImages = images.length < 3 ? images : images.slice(2);

      if (vintedImages.length > 0) {
        const absoluteImagePaths = vintedImages.map((imgPath) => {
          if (path.isAbsolute(imgPath)) return imgPath;
          return path.resolve(process.env.UPLOAD_DIR || './uploads', path.basename(imgPath));
        }).filter((p) => fs.existsSync(p));

        if (absoluteImagePaths.length > 0) {
          console.log(
            '[VintedPublish] Uploading %d photos (%s): %j',
            absoluteImagePaths.length,
            images.length < 3 ? 'all photos (less than 3)' : 'skipped first 2',
            absoluteImagePaths
          );
          const fileInput = await this.page.waitForSelector(
            'input[data-testid="add-photos-input"], input[name="photos"], input[type="file"][accept*="image"]',
            { state: 'attached', timeout: 15000 }
          );
          if (fileInput) {
            await fileInput.setInputFiles(absoluteImagePaths);
            // Give time for uploads to process
            await this.page.waitForTimeout(Math.min(3000 + absoluteImagePaths.length * 1500, 15000));
          }
        }
      }

      // 2. Title: Use specific vintedTitle if provided, else fallback to standard title
      const titleToUse = (product.vintedTitle || product.title).trim();
      const titleInput = await this.page.waitForSelector(
        'input[data-testid="title--input"], #title, input[name="title"]',
        { timeout: 10000 }
      );
      if (titleInput) {
        await titleInput.click();
        await titleInput.fill(titleToUse);
        await this.randomDelay(300, 600);
      }

      // 3. Description: Use specific vintedDescription if provided, else fallback
      const descToUse = (product.vintedDescription || product.description).trim();
      const descInput = await this.page.waitForSelector(
        'textarea[data-testid="description--input"], #description, textarea[name="description"]',
        { timeout: 10000 }
      );
      if (descInput) {
        await descInput.click();
        await descInput.fill(descToUse);
        await this.randomDelay(300, 600);
      }

      // 4. Category
      await this.selectCategory(product.vintedCategory || product.category, product.subcategory);

      // 5. Brand (Marca)
      await this.selectBrand(product.brand);

      // 6. Size (Talla)
      await this.selectSize(product.vintedSize);

      // 7. Condition (Estado) - Всегда берем второй пункт
      await this.selectCondition(product.condition);

      // 8. Color (Color)
      await this.selectColor(product.color);

      // 9. Material (Material)
      await this.selectMaterial((product as any).material);

      // 10. Fill any other dynamic dropdowns/fields Vinted might render for this category
      await this.fillRemainingDynamicFields();

      // 11. Price: Use vintedPrice if provided, else standard price
      const priceToUse = product.vintedPrice ?? product.price;
      const priceInput = await this.page.waitForSelector(
        'input[data-testid="price-input--input"], #price, input[name="price"]',
        { timeout: 10000 }
      );
      if (priceInput) {
        await priceInput.click();
        await priceInput.fill(priceToUse.toString().replace('.', ','));
        await this.randomDelay(400, 700);
      }

      // 12. Package size / Shipping - всегда размер 5 кг (Grande y pesado / 8-package-size / Grande)
      await this.handlePackageSize();

      // Wait after photo uploads for Vinted processing & anti-spam cooldown
      await this.page.waitForTimeout(4000);

      // 13. Submit form ("Subir" / "Añadir")
      const submitBtn = await this.page.$(
        'button[data-testid="upload-form-save-button"], button[type="button"]:has-text("Subir"), button[type="submit"]:has-text("Subir")'
      );

      if (submitBtn) {
        console.log('[VintedPublish] Clicking submit button...');
        await submitBtn.scrollIntoViewIfNeeded().catch(() => null);
        await this.page.waitForTimeout(500);
        await submitBtn.click();

        // Wait for redirect to item page or profile
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await this.page.waitForTimeout(3000);

        const currentUrl = this.page.url();
        console.log('[VintedPublish] Post-submit URL: %s', currentUrl);

        if (currentUrl.includes('/items/') && !currentUrl.includes('/items/new')) {
          const match = currentUrl.match(/\/items\/(\d+)/);
          const vintedId = match ? match[1] : undefined;
          return {
            success: true,
            vintedId,
            url: currentUrl,
          };
        }

        // Check if modal error ("Se ha producido un error") appeared
        const modalError = await this.page.$('h1:has-text("Se ha producido un error"), h2:has-text("Se ha producido un error"), div:has-text("Se ha producido un error")');
        if (modalError) {
          // If modal error appeared, let's retry clicking Subir once after 3 seconds
          console.warn('[VintedPublish] Modal error appeared, dismissing and retrying...');
          const closeOrRefresh = await this.page.$('button:has-text("Actualizar página"), [data-testid="modal-close"]');
          if (closeOrRefresh) {
            await closeOrRefresh.click().catch(() => null);
            await this.page.waitForTimeout(3000);
            await submitBtn.click().catch(() => null);
            await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
            await this.page.waitForTimeout(3000);
          }
        }

        const retryUrl = this.page.url();
        if (retryUrl.includes('/items/') && !retryUrl.includes('/items/new')) {
          const match = retryUrl.match(/\/items\/(\d+)/);
          return {
            success: true,
            vintedId: match ? match[1] : undefined,
            url: retryUrl,
          };
        }

        // Check if there was an error message on the page
        const errorElem = await this.page.$('[class*="FormHelpText--error"], [role="alert"]');
        if (errorElem) {
          const errText = await errorElem.innerText();
          if (errText && errText.trim()) {
            return { success: false, error: `Помилка форми Vinted: ${errText.trim()}` };
          }
        }

        // Если URL всё еще /items/new — товар НЕ опубликовался (форма осталась открытой)
        if (currentUrl.includes('/items/new')) {
          const screenshotPath = path.resolve(`./debug-screenshots/vinted-unsubmitted-${product.id}.png`);
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          await this.page?.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);

          // Проверяем валидационные ошибки инпутов
          const validationErrors = await this.page.$$eval(
            '[data-bloom="true"] [role="alert"], [class*="error"], [class*="helper-error"]',
            (elements) => elements.map((e) => e.textContent?.trim()).filter(Boolean)
          ).catch(() => []);

          const errorDetail = validationErrors.length > 0 ? validationErrors.join('; ') : 'Оголошення не збереглося (сторінка не змінилась)';
          return {
            success: false,
            error: `Vinted: ${errorDetail}`,
          };
        }

        return {
          success: true,
          url: currentUrl,
        };
      } else {
        return { success: false, error: 'Кнопку відправки "Subir" не знайдено на сторінці Vinted' };
      }
    } catch (err: any) {
      console.error('[VintedPublish] Error publishing to Vinted:', err);
      // Capture debug screenshot
      try {
        const screenshotPath = path.resolve(`./debug-screenshots/vinted-error-${product.id}.png`);
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await this.page?.screenshot({ path: screenshotPath, fullPage: true });
        console.log('[VintedPublish] Saved error screenshot to %s', screenshotPath);
      } catch (_) {}

      return { success: false, error: err.message || 'Невідома помилка публікації на Vinted' };
    }
  }

  // ─── Field Helpers ──────────────────────────────────────────────────────────

  private async selectCategory(categoryName?: string, subcategoryName?: string | null): Promise<void> {
    if (!this.page) return;
    try {
      const categoryTrigger = await this.page.$(
        'button[data-testid="catalog-select-dropdown-input"], #category, input[name="category"]'
      );
      if (categoryTrigger) {
        await categoryTrigger.click();
        await this.page.waitForTimeout(800);

        // Идем в глубь дерева категорий внутри [data-testid="catalog-select-dropdown-content"]
        // пока не кликнем конечный радио-пункт div[role="radio"]
        for (let step = 0; step < 4; step++) {
          // Проверяем, есть ли радио-кнопки (конечный уровень категории)
          const radioOptions = await this.page.$$('[data-testid="catalog-select-dropdown-content"] div[role="radio"]');
          if (radioOptions.length > 0) {
            // Если есть конкретный matching по подкатегории/категории
            let chosen = radioOptions[0];
            const search = (subcategoryName || categoryName || '').toLowerCase().trim();
            if (search) {
              for (const r of radioOptions) {
                const text = (await r.innerText()).toLowerCase();
                if (text.includes(search)) {
                  chosen = r;
                  break;
                }
              }
            }
            console.log('[VintedPublish] Selecting final leaf category radio: %s', await chosen.innerText());
            await chosen.click();
            await this.page.waitForTimeout(1000);
            return;
          }

          // Если мы еще на промежуточном уровне (ветки с шевронами div[role="button"])
          const buttons = await this.page.$$('[data-testid="catalog-select-dropdown-content"] div[role="button"]');
          if (buttons.length === 0) break;

          let targetBtn = buttons[0];
          const query = (step === 0 ? (categoryName || 'Hogar') : (subcategoryName || '')).toLowerCase().trim();

          if (query) {
            for (const b of buttons) {
              const text = (await b.innerText()).toLowerCase();
              if (text.includes(query)) {
                targetBtn = b;
                break;
              }
            }
          }

          console.log('[VintedPublish] Category step %d: clicking %s', step, await targetBtn.innerText());
          await targetBtn.click();
          await this.page.waitForTimeout(800);
        }

        // Если выпадающее меню вдруг осталось открытым, закрываем Escape
        await this.page.keyboard.press('Escape').catch(() => null);
        await this.page.waitForTimeout(400);
      }
    } catch (e) {
      console.warn('[VintedPublish] Category selection skipped or failed:', e);
      await this.page?.keyboard.press('Escape').catch(() => null);
    }
  }

  private async selectBrand(brand?: string | null): Promise<void> {
    if (!this.page) return;
    try {
      const brandBtn = await this.page.$(
        'button[data-testid="brand-select-dropdown-input"], #brand, [data-testid="brand-select-dropdown-input"]'
      );
      if (brandBtn) {
        await brandBtn.click();
        await this.page.waitForTimeout(600);

        let selected = false;
        const brandQuery = (brand || '').trim();
        if (brandQuery) {
          const searchInput = await this.page.$('input[placeholder*="buscar" i], input[type="search"], input[type="text"]');
          if (searchInput) {
            await searchInput.fill(brandQuery);
            await this.page.waitForTimeout(600);
            const matchItem = await this.page.$(
              `div[role="menuitem"]:has-text("${brandQuery}"), button:has-text("${brandQuery}"), li:has-text("${brandQuery}")`
            );
            if (matchItem) {
              await matchItem.click();
              selected = true;
            }
          }
        }

        // Если бренда нет в списке или не нашли — берем первый который там будет
        if (!selected) {
          const firstOption = await this.page.$(
            '[data-radix-popper-content-wrapper] div[role="radio"], [data-radix-popper-content-wrapper] [role="menuitem"], [role="menu"] div[role="radio"], [role="menu"] [role="menuitem"]'
          );
          if (firstOption) {
            await firstOption.click();
          }
        }
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[VintedPublish] Brand selection failed:', e);
    }
  }

  private async selectCondition(_wallapopCondition?: string): Promise<void> {
    if (!this.page) return;
    try {
      // Требование: состояние всегда брать второй пункт
      const condBtn = await this.page.$(
        'button[data-testid="category-condition-single-list-input"], #condition'
      );
      if (condBtn) {
        await condBtn.scrollIntoViewIfNeeded().catch(() => null);
        await condBtn.click();
        await this.page.waitForTimeout(600);

        // В выпадающем меню состояния опции имеют div[role="radio"] внутри popover:
        // 1-й пункт: Nuevo con etiquetas
        // 2-й пункт: Nuevo sin etiquetas (или En muy buen estado)
        const radioItems = await this.page.$$(
          '[data-radix-popper-content-wrapper] div[role="radio"], [role="menu"] div[role="radio"], div[role="radio"]'
        );

        if (radioItems.length >= 2) {
          console.log('[VintedPublish] Selecting 2nd condition option: %s', await radioItems[1].innerText().catch(() => 'item 2'));
          await radioItems[1].click();
        } else if (radioItems.length === 1) {
          await radioItems[0].click();
        }
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[VintedPublish] Condition selection failed:', e);
    }
  }

  private async selectSize(size?: string | null): Promise<void> {
    if (!this.page) return;
    try {
      const sizeBtn = await this.page.$(
        'button[data-testid="category-size-single-grid-input"], #size, [data-testid="category-size-single-grid-input"]'
      );
      if (sizeBtn) {
        await sizeBtn.click();
        await this.page.waitForTimeout(600);

        let selected = false;
        if (size && size.trim()) {
          const sizeOption = await this.page.$(`text="${size.trim()}"`);
          if (sizeOption) {
            await sizeOption.click();
            selected = true;
          }
        }

        // Если нет в списке — берем первый доступный пункт
        if (!selected) {
          const firstOption = await this.page.$(
            'div[role="menuitem"], [role="option"], ul li, div[data-bloom="true"] button'
          );
          if (firstOption) {
            await firstOption.click();
          }
        }
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[VintedPublish] Size selection failed:', e);
    }
  }

  private async selectColor(color?: string | null): Promise<void> {
    if (!this.page) return;
    try {
      const colorBtn = await this.page.$(
        'button[data-testid="color-select-dropdown-input"], #color, [data-testid="color-select-dropdown-input"]'
      );
      if (colorBtn) {
        await colorBtn.click();
        await this.page.waitForTimeout(600);

        let selected = false;
        if (color && color.trim()) {
          const colorOption = await this.page.$(`text="${color.trim()}"`);
          if (colorOption) {
            await colorOption.click();
            selected = true;
          }
        }

        // Если нет — берем первый
        if (!selected) {
          const firstOption = await this.page.$(
            'div[role="menuitem"], [role="option"], ul li, div[data-bloom="true"] button'
          );
          if (firstOption) {
            await firstOption.click();
          }
        }
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[VintedPublish] Color selection failed:', e);
    }
  }

  private async selectMaterial(material?: string | null): Promise<void> {
    if (!this.page) return;
    try {
      const matBtn = await this.page.$(
        'button[data-testid="category-material-multi-list-input"], #material, [data-testid="category-material-multi-list-input"]'
      );
      if (matBtn) {
        await matBtn.click();
        await this.page.waitForTimeout(600);

        let selected = false;
        if (material && material.trim()) {
          const matOption = await this.page.$(`text="${material.trim()}"`);
          if (matOption) {
            await matOption.click();
            selected = true;
          }
        }

        if (!selected) {
          const firstOption = await this.page.$(
            'div[role="menuitem"], [role="option"], ul li, div[data-bloom="true"] button'
          );
          if (firstOption) {
            await firstOption.click();
          }
        }
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[VintedPublish] Material selection failed:', e);
    }
  }

  private async fillRemainingDynamicFields(): Promise<void> {
    if (!this.page) return;
    try {
      // Находим все незаполненные селекторы/выпадающие списки в блоке Detalles del artículo
      // Они имеют структуру button[aria-haspopup="menu"] или input.select-proxy с пустым значением
      const unselectedButtons = await this.page.$$(
        '.select-wrapper button[aria-haspopup="menu"][data-placeholder=""]'
      );

      for (const btn of unselectedButtons) {
        try {
          const isCategory = await btn.getAttribute('data-testid');
          if (isCategory === 'catalog-select-dropdown-input') continue;

          await btn.click();
          await this.page.waitForTimeout(600);

          // Берем первый доступный вариант в открывшемся списке/меню
          const option = await this.page.$(
            'div[role="menuitem"], [role="option"], ul[role="listbox"] li, div[data-bloom="true"] button, label.web_ui__Radio__radio'
          );
          if (option) {
            await option.click();
            await this.page.waitForTimeout(400);
          } else {
            // Если модалка или список закрывается кликом вовне
            await this.page.keyboard.press('Escape').catch(() => null);
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[VintedPublish] fillRemainingDynamicFields notice:', e);
    }
  }

  private async handlePackageSize(): Promise<void> {
    if (!this.page) return;
    try {
      // Требование: размер всегда брать 5 кг (Grande y pesado / 8-package-size / или Grande)
      const heavyCell = await this.page.$(
        '[data-testid="8-package-size--cell"], [data-testid="8-package-size--cell--suffix"], #package-size-8, label[for="package_type_selector_8"], [data-testid="package_type_selector_8"]'
      );
      if (heavyCell) {
        await heavyCell.click();
        return;
      }

      // Если пункта 8 нет, берем пункт 3 (Grande)
      const grandCell = await this.page.$(
        '[data-testid="3-package-size--cell"], #package-size-3, label[for="package_type_selector_3"]'
      );
      if (grandCell) {
        await grandCell.click();
        return;
      }

      // Любой radio размера
      const anyRadio = await this.page.$('input[name*="package_type_selector"]');
      if (anyRadio) {
        await anyRadio.click();
      }
    } catch (_) {}
  }

  private async randomDelay(minMs: number, maxMs: number): Promise<void> {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    if (this.page) {
      await this.page.waitForTimeout(delay);
    }
  }
}

export const vintedBrowserService = new VintedBrowserService();
