import { Browser, BrowserContext, ElementHandle, Locator, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Product } from '@prisma/client';
import { PublishResult } from '../types';
import { resolveUploadedPhoto } from '../uploads';

const COOKIES_PATH = path.join(process.cwd(), '.vinted-cookies.json');
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CATEGORY_INPUT = '[data-testid="catalog-select-dropdown-input"], #category, input[name="category"], button[data-testid*="catalog"][aria-haspopup]';
const CATEGORY_WARNING = /\b(?:elige|selecciona|choose|select)\s+(?:(?:una?|an?)\s+)?(?:sub)?categor(?:ía|ia|y)\b/i;
const FIELD_ALERT = '[role="alert"], [class*="FormHelpText--error"], [class*="Validation__warning"], [class*="Validation__error"]';
const SUBMIT_ERROR = ':is(h1, h2, [role="dialog"], [class*="Dialog__modal"]):has-text("Se ha producido un error"):visible';
const MAX_SUBMIT_ATTEMPTS = 4;
const TITLE_INPUT = 'input[data-testid="title--input"], #title, input[name="title"]';
const DESCRIPTION_INPUT = 'textarea[data-testid="description--input"], #description, textarea[name="description"]';
const PRICE_INPUT = 'input[data-testid="price-input--input"], #price, input[name="price"]';
const DROPDOWN_CONTENT = '[data-radix-popper-content-wrapper], [role="listbox"], [role="menu"], [class*="input-dropdown__popover"], [class*="input-dropdown__dropdown"]';
const DROPDOWN_OPTION = '[role="radio"], [role="checkbox"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], input[type="radio"], input[type="checkbox"]';
const DETAIL_ROLE = '[role="radio"], [role="checkbox"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="menuitem"]';
const DETAIL_OPTION = DETAIL_ROLE + ', label:has(input:is([type="radio"], [type="checkbox"]):enabled), input:is([type="radio"], [type="checkbox"]):not(label input)';
const CHECKED_CHOICE = '[aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="selected"], [data-selected="true"]';
const CHECKED_INPUT = 'input:is([type="radio"], [type="checkbox"]):checked';
const DETAIL_TIMEOUT = 2500;
const CATEGORY_MENU = '[data-testid="catalog-select-dropdown-content"], [data-testid="catalog-select-dropdown-list"], [data-testid^="catalog"][data-testid$="-dropdown-content"], '
  + DROPDOWN_CONTENT + ', [role="dialog"]:not(:has(:is(' + CATEGORY_INPUT + ')))';
const CATEGORY_LEAF = '[role="radio"], [role="menuitemradio"], [role="option"], input[type="radio"], label:has(input[type="radio"])';
const FIELD_CONTROL = 'input:not([type="hidden"], [type="checkbox"], [type="radio"], [type="file"]), textarea, select, [role="combobox"], button[aria-haspopup], button[data-testid$="-input"]';
const DETAIL_INPUTS = {
  brand: '#brand, [data-testid="brand-select-dropdown-input"]',
  size: '#size, [data-testid*="category-size"][data-testid$="-input"]',
  condition: '#condition, select[name="condition"], input[readonly][name="condition"], [data-testid*="condition"][data-testid$="-input"]',
  color: '#color, [data-testid="color-select-dropdown-input"], [data-testid*="category-color"][data-testid$="-input"]',
  material: '#material, [data-testid*="category-material"][data-testid$="-input"]',
};

function hasDropdownValue(element: Node): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const prompt = /^(?:elige|elegir|selecciona[rs]?|seleccione|escoge|choose|select)(?:\s|$)/i;
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.selectedOptions).some(option => option.value.trim() && !prompt.test(option.label.trim()));
  }
  if (element instanceof HTMLInputElement) {
    return Boolean(element.value.trim() && element.value.trim() !== element.getAttribute('placeholder')?.trim());
  }
  if (element.hasAttribute('data-placeholder') && element.getAttribute('data-placeholder') !== 'false') return false;
  const value = element.getAttribute('aria-valuetext') || element.getAttribute('data-value');
  if (value?.trim()) return true;
  const text = element.textContent?.trim();
  if (!text || prompt.test(text)) return false;
  const labels = 'labels' in element ? (element as HTMLButtonElement).labels : null;
  return !Array.from(labels || []).some(label => label.textContent?.trim() === text)
    && !/^(?:marca|brand|estado|condition|talla|medidas|size|colou?r|material|categoría|category|formato|format)$/i.test(text);
}

export class VintedBrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isHeadless = true;
  private hasRateLimit = false;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(headless: boolean): Promise<void> {
    if (this.browser) {
      await this.close();
    }

    this.isHeadless = headless;
    this.hasRateLimit = false;

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

    this.sanitizeCookiesFile();

    this.context = await this.browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: headless ? { width: 1280, height: 800 } : null,
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      storageState: fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : undefined,
    });

    // Ensure user authentication cookies from vinted.com and vinted.es are properly aligned
    if (fs.existsSync(COOKIES_PATH)) {
      try {
        const rawData = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        const cookiesList: any[] = rawData.cookies || [];

        // Find authentic user token (scope: "user")
        const userToken = cookiesList.find((c) =>
          c.name === 'access_token_web' && c.value?.startsWith('ey') &&
          (() => {
            try {
              const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
              return p.scope === 'user';
            } catch {
              return false;
            }
          })()
        );

        const vUidCookie = cookiesList.find((c) => c.name === 'v_uid');
        const vSidCookie = cookiesList.find((c) => c.name === 'v_sid');

        // Remove any public/guest tokens that override authenticated sessions
        const cleanedCookies = cookiesList.filter((c) => {
          if (c.name === 'access_token_web' && userToken) {
            try {
              const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
              if (p.scope === 'public') return false;
            } catch {}
          }
          return true;
        });

        // Ensure user token and v_uid/v_sid exist on .vinted.es, www.vinted.es, .vinted.com, www.vinted.com
        const domains = ['.vinted.es', 'www.vinted.es', '.vinted.com', 'www.vinted.com'];
        if (userToken) {
          for (const d of domains) {
            cleanedCookies.push({ ...userToken, domain: d });
            if (vUidCookie) cleanedCookies.push({ ...vUidCookie, domain: d });
            if (vSidCookie) cleanedCookies.push({ ...vSidCookie, domain: d });
          }
        }

        await this.context.addCookies(cleanedCookies).catch(() => null);
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
      this.sanitizeCookiesFile();
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

      this.sanitizeCookiesFile();

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
        this.sanitizeCookiesFile();
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
      if (this.context && !this.hasRateLimit) {
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

  clearCookies(): boolean {
    let deleted = false;
    const pathsToCheck = [
      COOKIES_PATH,
      path.resolve(__dirname, '../../.vinted-cookies.json'),
      path.resolve(process.cwd(), '.vinted-cookies.json'),
      path.resolve(process.cwd(), '../.vinted-cookies.json'),
    ];
    for (const p of pathsToCheck) {
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          deleted = true;
          console.log('[VintedBrowser] Cleared cookies file %s', p);
        }
      } catch (err) {
        console.warn('[VintedBrowser] Error deleting %s:', p, err);
      }
    }
    return deleted;
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

      // Check if Vinted returned Rate Limit page
      const isRateLimited = await this.page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text.includes('You are rate limited') || text.includes('blocked for this computer');
      }).catch(() => false);

      if (isRateLimited) {
        this.hasRateLimit = true;
        return {
          success: false,
          error: 'Vinted тимчасово обмежив доступ (You are rate limited: blocked due to too many requests). Зробіть паузу 15-30 хв або змініть IP.',
        };
      }

      // Disable hover and click events on sticky header so it never opens menus or intercepts clicks
      await this.page.evaluate(() => {
        const header = document.querySelector('header, .site-header, [data-testid="header"]');
        if (header) {
          (header as HTMLElement).style.pointerEvents = 'none';
        }
      }).catch(() => null);

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
        const absoluteImagePaths = vintedImages.map(resolveUploadedPhoto).filter((p): p is string => p !== null);

        if (absoluteImagePaths.length > 0) {
          console.log(
            '[VintedPublish] Uploading %d photos (%s): %j',
            absoluteImagePaths.length,
            images.length < 3 ? 'all photos (less than 3)' : 'skipped first 2',
            absoluteImagePaths
          );
          let fileInput = await this.page.$(
            'input[data-testid="add-photos-input"], input[name="photos"], input[type="file"][accept*="image"]'
          );
          if (!fileInput) {
            fileInput = await this.page.waitForSelector(
              'input[data-testid="add-photos-input"], input[name="photos"], input[type="file"][accept*="image"]',
              { state: 'attached', timeout: 25000 }
            ).catch(async () => {
              const criticalDialog = await this.page?.$('[data-testid*="critical-error"], [data-testid="item-upload-critical-error-dialog"]');
              if (criticalDialog && await criticalDialog.isVisible().catch(() => false)) {
                const dialogText = await criticalDialog.innerText().catch(() => '');
                const cleanMsg = dialogText.replace(/\s+/g, ' ').trim();
                throw new Error(`Vinted показав критичну помилку форми: ${cleanMsg || 'item-upload-critical-error-dialog'}`);
              }
              const currentUrl = this.page?.url() || '';
              if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
                throw new Error('Сесія Vinted завершилась (редирект на авторизацію).');
              }
              return null;
            });
          }
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
        TITLE_INPUT,
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
        DESCRIPTION_INPUT,
        { timeout: 10000 }
      );
      if (descInput) {
        await descInput.click();
        await descInput.fill(descToUse);
        await this.randomDelay(300, 600);
      }

      // 4. Category
      await this.selectCategory(product.vintedCategory || product.category, product.subcategory);
      await this.fillProductDetails(product);

      // 11. Price: Use vintedPrice if provided, else standard price
      const priceToUse = product.vintedPrice ?? product.price;
      const priceInput = await this.page.waitForSelector(
        PRICE_INPUT,
        { timeout: 10000 }
      );
      if (priceInput) {
        await priceInput.fill(priceToUse.toString().replace('.', ','), { timeout: 5000 });
        await this.randomDelay(400, 700);
      }

      // 12. Package size / Shipping - всегда размер 5 кг (Grande y pesado / 8-package-size / Grande)
      await this.handlePackageSize();

      // Wait after photo uploads for Vinted processing & anti-spam cooldown
      await this.page.waitForTimeout(4000);

      const submitBtn = this.page.locator(
        'button[data-testid="upload-form-save-button"]:visible, button:text-is("Subir"):visible'
      ).first();
      if (!await submitBtn.count()) {
        return { success: false, error: 'Кнопку відправки "Subir" не знайдено на сторінці Vinted' };
      }

      const formUrl = this.page.url();
      const alerts = this.page.locator(`:is(${FIELD_ALERT}):visible`);
      const errorModal = this.page.locator(SUBMIT_ERROR).first();
      const repairedFields = new Set<string>();
      let retriedModal = false;

      for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
        await this.dismissAuthenticityModal();
        const criticalDialog = this.page.locator('[data-testid*="critical-error"]').first();
        if (await criticalDialog.isVisible()) {
          const message = (await criticalDialog.innerText()).replace(/\s+/g, ' ').trim();
          return { success: false, error: `Vinted показав критичну помилку форми: ${message || 'item-upload-critical-error-dialog'}` };
        }

        const previousMessages = attempt === 0 ? [] : await alerts.allTextContents();
        console.log('[VintedPublish] Clicking submit button (attempt %d)...', attempt + 1);
        await submitBtn.click({ timeout: 5000 });
        await this.page.waitForFunction(({ url, alertSelector, previousMessages }) => {
          if (location.href !== url || document.body?.innerText.includes('Se ha producido un error')) return true;
          return Array.from(document.querySelectorAll<HTMLElement>(alertSelector)).some(element => {
            const message = element.textContent?.trim();
            return element.getClientRects().length && getComputedStyle(element).visibility === 'visible'
              && message && !previousMessages.includes(message);
          });
        }, {
          url: formUrl,
          alertSelector: FIELD_ALERT,
          previousMessages: previousMessages.map(message => message.trim()),
        }, { timeout: 30000, polling: 150 }).then(result => result.dispose()).catch(() => null);

        if (this.page.url() !== formUrl || attempt === MAX_SUBMIT_ATTEMPTS - 1) break;
        if (await errorModal.isVisible()) {
          if (retriedModal) break;
          const close = this.page.locator('button:has-text("Actualizar página"):visible, [data-testid="modal-close"]:visible').first();
          if (!await close.isVisible()) break;
          await close.click({ timeout: 5000 });
          await this.page.waitForTimeout(3000);
          retriedModal = true;
          continue;
        }

        if (!await this.repairValidationErrors(product, alerts, repairedFields)) break;
      }

      const currentUrl = this.page.url();
      console.log('[VintedPublish] Post-submit URL: %s', currentUrl);
      if (currentUrl.includes('/member/') || (currentUrl.includes('/items/') && !currentUrl.includes('/items/new'))) {
        const match = currentUrl.match(/\/items\/(\d+)/);
        return { success: true, vintedId: match?.[1], url: currentUrl };
      }

      const messages = [...new Set((await alerts.allTextContents()).map(message => message.trim()).filter(Boolean))];
      if (messages.length > 0) {
        return { success: false, error: 'Помилка форми Vinted: ' + messages.join('; ') };
      }
      if (await errorModal.isVisible()) {
        return { success: false, error: 'Vinted: Se ha producido un error' };
      }
      if (currentUrl.includes('/items/new')) {
        const screenshotPath = path.resolve('./debug-screenshots/vinted-unsubmitted-' + product.id + '.png');
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
        return { success: false, error: 'Vinted: Оголошення не збереглося (сторінка не змінилась)' };
      }
      return { success: true, url: currentUrl };
    } catch (err: any) {
      console.error('[VintedPublish] Error publishing to Vinted:', err);
      // Capture debug screenshot
      try {
        const screenshotPath = path.resolve(`./debug-screenshots/vinted-error-${product.id}.png`);
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await this.page?.screenshot({ path: screenshotPath, fullPage: true });
        console.log('[VintedPublish] Saved error screenshot to %s', screenshotPath);
      } catch (_) {}

      // Check if Vinted blocked with rate limit or critical dialog
      try {
        const isRateLimited = await this.page?.evaluate(() => {
          const text = document.body?.innerText || '';
          return text.includes('You are rate limited') || text.includes('blocked for this computer');
        });
        if (isRateLimited) {
          this.hasRateLimit = true;
          return {
            success: false,
            error: 'Vinted заблокував доступ за забагато запитів (You are rate limited). Зробіть паузу 15-30 хв або змініть IP.',
          };
        }

        const critDialog = await this.page?.$('[data-testid*="critical-error"], [data-testid="item-upload-critical-error-dialog"]');
        if (critDialog && await critDialog.isVisible().catch(() => false)) {
          const dialogText = await critDialog.innerText().catch(() => '');
          const cleanMsg = dialogText.replace(/\s+/g, ' ').trim();
          return {
            success: false,
            error: `Vinted показав критичну помилку форми: ${cleanMsg || 'item-upload-critical-error-dialog'}`,
          };
        }
      } catch (_) {}

      return { success: false, error: err.message || 'Невідома помилка публікації на Vinted' };
    }
  }

  // ─── Field Helpers ──────────────────────────────────────────────────────────

  private async repairValidationErrors(product: Product, alerts: Locator, repairedFields: Set<string>): Promise<boolean> {
    const messages = await alerts.allTextContents();
    const repairCategory = async () => {
      if (repairedFields.has('category')) return false;
      repairedFields.add('category');
      console.log('[VintedPublish] Retrying category after validation warning');
      if (!await this.selectCategory(product.vintedCategory || product.category, product.subcategory, true)) return false;
      await this.fillProductDetails(product);
      await this.handlePackageSize();
      return true;
    };
    let repaired = messages.some(message => CATEGORY_WARNING.test(message)) && await repairCategory();

    const valueFields = {
      title: { selector: TITLE_INPUT, value: product.vintedTitle || product.title },
      description: { selector: DESCRIPTION_INPUT, value: product.vintedDescription || product.description },
      price: { selector: PRICE_INPUT, value: String(product.vintedPrice ?? product.price).replace('.', ',') },
      model: { selector: '#model, input[name="model"]', value: product.model },
      year: { selector: '#year, input[name="year"]', value: product.year?.toString() },
      style: { selector: '#style, input[name="style"]', value: product.style },
    };
    const details: Record<keyof typeof DETAIL_INPUTS, () => Promise<void>> = {
      brand: async () => {
        await this.selectDetailOption('brand', product.brand);
        await this.dismissAuthenticityModal();
      },
      size: () => this.selectSize(product.vintedSize),
      condition: () => this.selectDetailOption('condition'),
      color: () => this.selectDetailOption('color', product.color),
      material: () => this.selectDetailOption('material', product.material),
    };
    const selectors = Object.entries({
      category: CATEGORY_INPUT,
      ...DETAIL_INPUTS,
      ...Object.fromEntries(Object.entries(valueFields).map(([name, field]) => [name, field.selector])),
    });

    for (const alert of await alerts.elementHandles()) {
      const message = (await alert.textContent().catch(() => '') || '').trim();
      if (!message || CATEGORY_WARNING.test(message)) continue;
      try {
        if (/\b(?:tamaño|tamano|medidas) (?:del|de) paquete\b|\bpackage size\b/i.test(message)) {
          if (!repairedFields.has('package-size')) {
            repairedFields.add('package-size');
            repaired = await this.handlePackageSize() || repaired;
          }
          continue;
        }

        const control = await alert.evaluateHandle((element, selector) => {
          if (!(element instanceof HTMLElement) || !element.isConnected) return null;
          const controls = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
            field => field.getClientRects().length && getComputedStyle(field).visibility === 'visible'
              && !field.matches(':disabled, [aria-disabled="true"]'),
          );
          if (element.id) {
            const described = controls(document).find(field =>
              field.getAttribute('aria-describedby')?.split(/\s+/).includes(element.id)
              || field.getAttribute('aria-errormessage') === element.id);
            if (described) return described;
          }
          for (let parent = element.parentElement; parent && !parent.matches('form, main, body'); parent = parent.parentElement) {
            const fields = controls(parent);
            if (fields.length > 1) break;
            if (fields.length === 1) return fields[0];
          }
          return null;
        }, FIELD_CONTROL);
        try {
          const field = control.asElement();
          if (!field) continue;
          const identity = await field.evaluate((element, candidates) => ({
            name: candidates.find(([, selector]) => element.matches(selector))?.[0],
            key: element.id || element.getAttribute('data-testid') || element.getAttribute('name'),
            dropdown: element.matches('button, [role="combobox"], input[readonly]'),
            select: element instanceof HTMLSelectElement,
            empty: (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
              && !element.value.trim(),
          }), selectors);
          const key = identity.name || identity.key || message;
          if (key === 'category') {
            repaired = await repairCategory() || repaired;
            continue;
          }
          if (repairedFields.has(key)) continue;
          repairedFields.add(key);

          if (identity.name && Object.prototype.hasOwnProperty.call(details, identity.name)) {
            const previous = await field.evaluate(element =>
              element instanceof HTMLInputElement ? element.value : element.textContent);
            await details[identity.name as keyof typeof details]();
            const changed = await field.evaluate((element, value) =>
              !element.isConnected || (element instanceof HTMLInputElement ? element.value : element.textContent) !== value,
            previous);
            repaired = changed || !await alert.isVisible() || repaired;
          } else if (identity.name && Object.prototype.hasOwnProperty.call(valueFields, identity.name)) {
            const value = valueFields[identity.name as keyof typeof valueFields].value?.trim();
            if (value && identity.empty && !identity.dropdown && !identity.select) {
              await field.fill(value, { timeout: 3000 });
              repaired = true;
            }
          } else if (identity.select && identity.empty) {
            const option = await field.evaluate(element => Array.from((element as HTMLSelectElement).options)
              .find(option => option.value && !option.disabled && !option.closest('optgroup[disabled]'))?.value);
            if (option) {
              await field.selectOption(option, { timeout: 3000 });
              repaired = true;
            }
          } else if (identity.dropdown) {
            repaired = await this.fillDropdown(field) || repaired;
          }
        } finally {
          await control.dispose();
        }
      } catch (error) {
        console.warn('[VintedPublish] Could not repair validation warning "%s":', message, error);
      }
    }
    return repaired;
  }

  private async fillProductDetails(product: Product): Promise<void> {
    if (!this.page) return;
    const detailInputs = Object.values(DETAIL_INPUTS).join(', ');
    await this.page.locator(':is(' + detailInputs + '):visible').first()
      .waitFor({ state: 'visible', timeout: 1500 }).catch(() => null);
    await this.selectDetailOption('brand', product.brand);
    await this.dismissAuthenticityModal();
    await this.selectSize(product.vintedSize);
    await this.selectDetailOption('condition');
    await this.selectDetailOption('color', product.color);
    await this.selectDetailOption('material', product.material);
    await this.fillRemainingDynamicFields();
  }

  private async selectCategory(categoryName?: string, subcategoryName?: string | null, retry = false): Promise<boolean> {
    const page = this.page;
    if (!page) return false;

    const trigger = page.locator(`:is(${CATEGORY_INPUT}):visible`).first();
    const menu = page.locator(`:is(${CATEGORY_MENU}):visible`).first();
    const warning = page.locator(`:is(${FIELD_ALERT}):visible`).filter({ hasText: CATEGORY_WARNING }).first();
    const readSelection = async () => trigger.evaluate(element => ({
      value: (element instanceof HTMLInputElement ? element.value : element.textContent || '').trim(),
      placeholder: element.hasAttribute('data-placeholder') && element.getAttribute('data-placeholder') !== 'false',
    }), undefined, { timeout: 2000 });
    const normalize = (value: string) => value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const target = (subcategoryName?.trim().toLowerCase() === 'auto' ? '' : subcategoryName?.trim()) || categoryName?.trim() || '';
    const category = normalize(categoryName || '');
    const query = normalize(target);
    let opened = false;

    try {
      await trigger.waitFor({ state: 'visible', timeout: 5000 });
      const initial = await readSelection();
      const hasCategoryLabel = ({ value, placeholder }: typeof initial) =>
        value && !placeholder && !CATEGORY_WARNING.test(value) && !/^(?:sub)?categor(?:ía|ia|y)$/i.test(value);
      const isSelected = async () => {
        const selection = await readSelection();
        return Boolean(hasCategoryLabel(selection) && (selection.value !== initial.value || !await warning.isVisible()));
      };
      if (await isSelected()) return !retry;
      const existingPath = hasCategoryLabel(initial) ? initial.value.split(/\s+(?:>|›|\/|→)\s+/) : [];
      const existingLeaf = normalize(existingPath[existingPath.length - 1] || '');

      if (!existingPath.length) {
        const chips = await page.locator(`:is(button[data-testid*="catalog-suggestion"], button[data-testid*="category-suggestion"], [data-testid*="suggestion"] button):visible`).all();
        const active = await Promise.all(chips.map(chip => this.isElementChecked(chip)));
        if (!active.some(Boolean)) {
          const labels = await Promise.all(chips.map(option => option.innerText()));
          const match = labels.findIndex(label => query && normalize(label).includes(query));
          const suggested = chips[match === -1 ? 0 : match];
          if (suggested) {
            await suggested.click({ timeout: 2000 }).catch(() => null);
            opened = true;
            if (!await menu.isVisible() && await isSelected()) return true;
          }
        }
      }

      if (!await menu.isVisible()) await trigger.click({ timeout: 5000 });
      opened = true;
      await menu.waitFor({ state: 'visible', timeout: 3000 });
      const leaves = menu.locator(`:is(${CATEGORY_LEAF}):visible:not(:disabled, [aria-disabled="true"])`);
      const branches = menu.locator(`:is(div[role="button"], [role="menuitem"], button, [data-testid*="catalog"][data-testid$="--cell"]):not(:is(${CATEGORY_LEAF}), :disabled, [aria-disabled="true"], [data-testid*="chevron"]):visible`);
      const search = menu.locator('input:not([readonly], [disabled]):is([type="search"], [type="text"], [placeholder*="buscar" i], [placeholder*="search" i]):visible').first();
      if (!existingPath.length && target && await search.isVisible()) {
        await search.fill(target, { timeout: 2000 });
        // Vinted filters catalogs asynchronously when the search query changes.
        await page.waitForTimeout(500);
        if (!await leaves.count()) await search.fill('', { timeout: 2000 });
      }

      const findMatch = (labels: string[], name: string) => {
        if (!name) return -1;
        const exact = labels.indexOf(name);
        return exact === -1 ? labels.findIndex(label => label.includes(name)) : exact;
      };
      const other = /\b(?:otro|otra|otros|otras|general|other)\b/;
      let preferredRoot = /\bhogar\b/;
      if (/electronica|tecnologia|movil|consola|videojuego|ordenador|\bpc\b|audio|tele|camara/.test(category)) {
        preferredRoot = /electronica|entretenimiento/;
      } else if (/mascota|perro|gato|animal/.test(category)) {
        preferredRoot = /mascota/;
      } else if (/hombre|chico|caballero/.test(category)) {
        preferredRoot = /hombre/;
      } else if (/mujer|chica|dama/.test(category)) {
        preferredRoot = /mujer/;
      } else if (/nino|bebe|juguete/.test(category)) {
        preferredRoot = /\bninos?\b/;
      }

      for (let step = 0; step < 8; step++) {
        const branchOptions = await branches.all();
        const branchLabels = (await Promise.all(branchOptions.map(option => option.innerText()))).map(normalize);
        const leafOptions = await leaves.all();
        const leafLabels = (await Promise.all(leafOptions.map(option => option.innerText()))).map(normalize);
        const checked = await Promise.all(leafOptions.map(option => this.isElementChecked(option)));
        if (checked.some(Boolean) || (existingLeaf && leafLabels.includes(existingLeaf))) return !retry && await isSelected();

        const leafMatch = findMatch(leafLabels, query);
        let branchMatch = findMatch(branchLabels, query);
        if (branchMatch === -1 && step === 0) branchMatch = findMatch(branchLabels, category);
        const fallbackBranch = branchLabels.findIndex(label => (step === 0 ? preferredRoot : other).test(label));
        const firstBranch = branchLabels.findIndex(label => label && !/^(?:atras|volver|back)\b/.test(label));
        const currentLevel = existingPath[step];
        const existingBranch = findMatch(branchLabels, normalize(currentLevel || ''));
        if (existingBranch === -1 && currentLevel) {
          const insideBranch = leafOptions.length && await menu.getByText(currentLevel, { exact: true }).first().isVisible();
          if (!insideBranch) break;
        }
        const branch = branchOptions[existingBranch] || branchOptions[branchMatch] || branchOptions[fallbackBranch] || branchOptions[firstBranch];

        if (existingBranch === -1 && (leafMatch !== -1 || (branchMatch === -1 && leafOptions.length))) {
          const otherLeaf = leafLabels.findIndex(label => other.test(label));
          const index = leafMatch !== -1 ? leafMatch : Math.max(0, otherLeaf);
          await this.safeCheckOption(leafOptions[index], leafLabels[index]);
          return await isSelected();
        }
        if (!branch) break;
        await branch.click({ timeout: 3000 });
        await page.waitForTimeout(350);
        if (!await menu.isVisible()) return await isSelected();
      }
    } catch (error) {
      console.warn('[VintedPublish] Category selection failed:', error);
    } finally {
      if (opened && await menu.isVisible().catch(() => false)) await page.keyboard.press('Escape').catch(() => null);
    }
    return false;
  }

  private async dismissAuthenticityModal(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.waitForTimeout(500);
      const modal = await this.page.$(
        '[data-testid="authenticity-modal"], [data-testid="authenticity-modal--overlay"], div[class*="Dialog__portal"]:has-text("imitación"), div[class*="Dialog__modal"]:has-text("imitación")'
      );
      if (modal) {
        console.log('[VintedPublish] Authenticity modal detected, attempting to dismiss...');
        const confirmBtn = await this.page.$(
          'div[class*="Dialog__portal"] button:has-text("Entendido"), ' +
          'div[class*="Dialog__portal"] button:has-text("Aceptar"), ' +
          'div[class*="Dialog__portal"] button:has-text("Continuar"), ' +
          'div[class*="Dialog__portal"] button:has-text("Lo he entendido"), ' +
          'div[class*="Dialog__portal"] button:has-text("De acuerdo"), ' +
          '[data-testid="authenticity-modal"] button, ' +
          '[data-testid="authenticity-modal--overlay"] button, ' +
          'div[class*="Dialog__portal"] button[data-testid*="confirm"], ' +
          'div[class*="Dialog__portal"] [data-testid="modal-close"]'
        );

        if (confirmBtn) {
          await confirmBtn.click({ timeout: DETAIL_TIMEOUT }).catch(() => null);
          console.log('[VintedPublish] Clicked confirmation on Authenticity modal');
        } else {
          const anyBtn = await this.page.$('div[class*="Dialog__portal"] button');
          if (anyBtn) {
            await anyBtn.click({ timeout: DETAIL_TIMEOUT }).catch(() => null);
          } else {
            await this.page.keyboard.press('Escape').catch(() => null);
          }
        }
        await this.page.waitForTimeout(1000);
      }
    } catch (e) {
      console.warn('[VintedPublish] Error dismissing authenticity modal:', e);
    }
  }

  private async selectDetailOption(field: 'brand' | 'condition' | 'color' | 'material', value?: string | null): Promise<void> {
    const page = this.page;
    if (!page) return;

    const trigger = page.locator(`:is(${DETAIL_INPUTS[field]}):not(:disabled, [aria-disabled="true"]):visible`).first();
    if (!await trigger.isVisible()) return;
    const requested = value?.trim();
    const query = requested?.toLowerCase();
    const noBrand = /^\s*(?:publicar sin marca|sin marca|no brand|unbranded|sans marque)\s*$/i;
    let menu: Locator | undefined;
    let opened = false;
    try {
      if (await trigger.evaluate(hasDropdownValue, undefined, { timeout: DETAIL_TIMEOUT })) return;
      const control = await trigger.evaluate(element => {
        if (element instanceof HTMLSelectElement) {
          return {
            options: Array.from(element.options).filter(option =>
              option.value && !option.matches(':disabled') && !option.hidden,
            ).map(option => ({ value: option.value, label: option.text.trim() })),
            value: element.value,
          };
        }
        const ids = ['aria-controls', 'aria-owns'].flatMap(name =>
          (element.getAttribute(name) || '').split(/\s+/).filter(Boolean).map(id => '#' + CSS.escape(id)),
        );
        const testId = element.getAttribute('data-testid');
        if (testId?.endsWith('-input')) {
          const prefix = CSS.escape(testId.slice(0, -6));
          ids.push(...['-content', '-dropdown-content', '-list', '-options', '-dropdown']
            .map(suffix => '[data-testid="' + prefix + suffix + '"]'));
        }
        return { selector: ids.join(', ') };
      }, undefined, { timeout: DETAIL_TIMEOUT });

      if (control.options) {
        const match = control.options.find(option => option.label.toLowerCase() === query || option.value.toLowerCase() === query);
        const fallback = field === 'condition' ? control.options[1] || control.options[0] : control.options[0];
        const unbranded = control.options.find(option => noBrand.test(option.label));
        const option = match || (field === 'brand' ? unbranded : fallback);
        if (option && option.value !== control.value) await trigger.selectOption(option.value, { timeout: DETAIL_TIMEOUT });
        return;
      }

      const cells = `:is([data-testid*="${field}"][data-testid$="--cell"], [class*="Cell__cell"][role="button"]):not(:has(:is(${DETAIL_OPTION})))`;
      const brandOptions = field === 'brand' ? ', button:not(:has(:is(' + DETAIL_OPTION + ')))' : '';
      const enabled = ':not(:disabled, [aria-disabled="true"], [aria-disabled="true"] *, [aria-hidden="true"], [aria-hidden="true"] *):visible';
      const optionSelector = `:is(${DETAIL_OPTION}, ${cells}${brandOptions}):not(:is(${DETAIL_ROLE}) :is(${DETAIL_OPTION}), :is(${DETAIL_INPUTS[field]}), [role="menuitem"][aria-haspopup])${enabled}`;
      const searchSelector = `input:is([type="search"], [type="text"], :not([type])):not(:read-only)${enabled}`;
      const offering = page.locator(optionSelector);
      const content = field === 'brand' ? offering.or(page.locator(searchSelector)).or(page.getByText(noBrand)) : offering;
      const associated = control.selector ? page.locator(`:is(${control.selector}):visible`).filter({ has: content }).first() : undefined;
      const nearby = trigger.locator('xpath=ancestor::li[1]').filter({ has: content });
      const portals = page.locator(`:is(${DROPDOWN_CONTENT}, [role="dialog"], [class*="Dialog__modal"], [class*="dropdown__list"], [class*="dropdown__options"], [data-testid$="-dropdown-content"]):not([data-state="closed"], [aria-hidden="true"]):visible`)
        .filter({ has: content, hasNot: page.locator(DETAIL_INPUTS[field]) });
      const fallback = nearby.or(portals).first();
      if (associated && await associated.isVisible()) {
        menu = associated;
      } else {
        await trigger.click({ timeout: DETAIL_TIMEOUT });
        opened = true;
        await (associated ? associated.or(fallback).first() : fallback).waitFor({ state: 'visible', timeout: DETAIL_TIMEOUT });
        menu = associated && await associated.isVisible() ? associated : fallback;
      }

      const choices = menu.locator(optionSelector);
      if (field !== 'brand') await choices.first().waitFor({ state: 'visible', timeout: DETAIL_TIMEOUT });
      if (await this.hasCheckedChoice(menu)) return;
      if (field === 'brand') {
        const search = menu.locator(searchSelector).first();
        const waitFor = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: DETAIL_TIMEOUT })
          .then(() => true, () => false);
        if (requested) {
          if (await waitFor(search)) {
            if (await this.hasCheckedChoice(menu)) return;
            await search.fill(requested, { timeout: DETAIL_TIMEOUT });
          }
          const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const label = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
          const match = choices.filter({ hasText: label }).or(choices.filter({ has: page.getByText(label) })).first();
          if (await waitFor(match)) {
            if (!await trigger.evaluate(hasDropdownValue, undefined, { timeout: DETAIL_TIMEOUT })) {
              await match.click({ timeout: DETAIL_TIMEOUT });
            }
            return;
          }
        }
        const withoutBrand = menu.getByText(noBrand).or(page.getByText('Publicar sin marca', { exact: true }))
          .and(page.locator(enabled)).first();
        if (!await withoutBrand.isVisible() && await waitFor(search)) {
          if (await trigger.evaluate(hasDropdownValue, undefined, { timeout: DETAIL_TIMEOUT })) return;
          await search.fill('Sin marca', { timeout: DETAIL_TIMEOUT });
        }
        await withoutBrand.waitFor({ state: 'visible', timeout: DETAIL_TIMEOUT });
        if (!await trigger.evaluate(hasDropdownValue, undefined, { timeout: DETAIL_TIMEOUT })) {
          await withoutBrand.click({ timeout: DETAIL_TIMEOUT });
        }
        return;
      }

      if (field === 'condition') {
        // Default to the second condition when Vinted has left the field empty.
        await this.safeCheckOption(choices.nth(await choices.count() > 1 ? 1 : 0), 'condition', DETAIL_TIMEOUT);
        return;
      }

      const options = await choices.all();
      const labels = query ? await Promise.all(options.map(async option =>
        (await option.getAttribute('aria-label', { timeout: DETAIL_TIMEOUT })
          || await option.innerText({ timeout: DETAIL_TIMEOUT })).trim().toLowerCase(),
      )) : [];
      const exact = labels.indexOf(query || '');
      const match = exact === -1 && query ? labels.findIndex(label => label.includes(query)) : exact;
      if (match !== -1) {
        await this.safeCheckOption(options[match], field, DETAIL_TIMEOUT);
        return;
      }
      await this.safeCheckOption(choices.first(), field, DETAIL_TIMEOUT);
    } catch (error) {
      console.warn('[VintedPublish] Could not select %s:', field, error);
    } finally {
      if (menu ? await menu.isVisible().catch(() => false) : opened) {
        await page.keyboard.press('Escape').catch(() => null);
        await menu?.waitFor({ state: 'hidden', timeout: 500 }).catch(() => null);
        if (menu && await menu.isVisible().catch(() => false)) {
          const close = menu.locator('button[aria-label="Cerrar" i]:visible, button[aria-label="Close" i]:visible, [data-testid="modal-close"]:visible').first();
          if (await close.isVisible().catch(() => false)) {
            await close.click({ timeout: 1000 }).catch(() => null);
          } else {
            await trigger.click({ timeout: 1000 }).catch(() => null);
          }
        }
      }
    }
  }

  private async hasCheckedChoice(menu: Locator): Promise<boolean> {
    if (await menu.locator(`:is(${CHECKED_CHOICE}):visible, ${CHECKED_INPUT}`).count()) return true;
    const options = await menu.locator(`:is(${DETAIL_OPTION}):visible`).all();
    return (await Promise.all(options.map(option => this.isElementChecked(option)))).some(Boolean);
  }

  private async isElementChecked(el: any): Promise<boolean> {
    if (!el) return false;
    try {
      return await el.evaluate((node: any) => {
        if (!node) return false;
        // 1. Прямой input checkbox / radio
        if (node instanceof HTMLInputElement) {
          return node.checked;
        }
        // 2. Атрибут aria-checked="true"
        if (node.matches('[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"], [data-state="checked"], [data-state="selected"], [data-selected="true"]')) {
          return true;
        }
        // 3. Дочерний input checkbox / radio с флагом checked
        if (node.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')) {
          return true;
        }
        // 4. Наличие атрибута checked
        if (node.hasAttribute('checked') && node.getAttribute('checked') !== 'false') {
          return true;
        }
        // 5. CSS классы активного/выбранного чекбокса
        if (node.matches('[aria-checked="false"], [aria-selected="false"], [data-state="unchecked"], [data-selected="false"]')) return false;
        const classNames = Array.from(node.classList as DOMTokenList);
        return classNames.some(name => /(?:^|[-_])(?:checked|selected)(?:$|[-_])/i.test(name)
          && !/(?:^|[-_])(?:not|un)[-_]?(?:checked|selected)(?:$|[-_])/i.test(name))
          || (node.matches('[role="radio"], [role="checkbox"], [role="menuitemcheckbox"], [role="menuitemradio"]')
            && classNames.some(name => /(?:^|[-_])active(?:$|[-_])/i.test(name)));
      });
    } catch {
      return false;
    }
  }

  private async safeCheckOption(el: any, description: string = 'option', timeout = 5000): Promise<boolean> {
    if (!el) return false;
    try {
      const alreadyChecked = await this.isElementChecked(el);
      if (alreadyChecked) {
        console.log(`[VintedPublish] Option "${description}" is ALREADY checked. Keeping it (no click).`);
        return true;
      }
      await el.click({ timeout });
      console.log(`[VintedPublish] Clicked to check option "${description}".`);
      return true;
    } catch (e) {
      console.warn(`[VintedPublish] Failed to check option "${description}":`, e);
      return false;
    }
  }

  private async selectSize(size?: string | null): Promise<void> {
    if (!this.page) return;
    let opened = false;
    try {
      const sizeBtn = this.page.locator(':is(' + DETAIL_INPUTS.size + '):visible').first();
      const sizeByName = this.page.getByRole('button', { name: /^(?:talla|elige la talla|medidas)$/i }).first();
      const trigger = await sizeBtn.isVisible() ? sizeBtn : sizeByName;
      if (await trigger.isVisible()) {
        if (await trigger.evaluate(hasDropdownValue, undefined, { timeout: DETAIL_TIMEOUT })) return;
        await trigger.click({ timeout: DETAIL_TIMEOUT });
        opened = true;
        await this.page.waitForTimeout(600);

        // Если вылезла отдельная информационная подсказка / модалка о таблице размеров с кнопкой закрытия/подтверждения
        const infoModalClose = await this.page.$(
          'div[class*="Dialog__modal"]:has-text("Tabla de tallas") button:has-text("Entendido"), ' +
          'div[class*="Dialog__modal"]:has-text("Tabla de tallas") button:has-text("Aceptar"), ' +
          'div[class*="Dialog__modal"]:has-text("Tabla de tallas") button:has-text("De acuerdo"), ' +
          'div[class*="Dialog__modal"]:has-text("Tabla de tallas") [data-testid="modal-close"]'
        );
        if (infoModalClose) {
          await infoModalClose.click({ timeout: DETAIL_TIMEOUT }).catch(() => null);
          await this.page.waitForTimeout(400);
        }

        const containerSelectors = [
          'div[class*="dropdown__content"]',
          '[data-radix-popper-content-wrapper]',
          'div[role="dialog"]',
          'div[class*="Dialog__modal"]',
          'div[class*="Sheet"]',
          'div[class*="flat"]'
        ];

        const nearby = trigger.locator('xpath=ancestor::li[1]');
        const menus = this.page.locator(`:is(${containerSelectors.join(', ')}, ${DROPDOWN_CONTENT}):not([data-state="closed"], [aria-hidden="true"]):visible`)
          .filter({ hasNot: this.page.locator(DETAIL_INPUTS.size) }).or(nearby);
        for (const menu of await menus.all()) {
          if (await this.hasCheckedChoice(menu)) return;
        }
        let selected = false;
        const sizeQuery = (size || '').trim().toLowerCase();

        // 1. Если указан конкретный размер, ищем совпадение по aria-label или тексту
        if (sizeQuery && !selected) {
          const directMatch = await this.page.$(
            `[role="checkbox"][aria-label*="${sizeQuery}" i], ` +
            `div[role="radio"][aria-label*="${sizeQuery}" i], ` +
            `[data-testid*="grid-option"][aria-label*="${sizeQuery}" i], ` +
            `div[class*="dropdown__content"] [role="checkbox"]:has-text("${sizeQuery}"), ` +
            `[data-radix-popper-content-wrapper] :has-text("${sizeQuery}")`
          );
          if (directMatch) {
            selected = await this.safeCheckOption(directMatch, `size ${sizeQuery}`, DETAIL_TIMEOUT);
          }
        }

        // 2. Если размер не указан или не найден — сначала проверяем прямой селектор "Otra" / "Otro"
        if (!selected) {
          const otraDirect = await this.page.$(
            'div[role="checkbox"][aria-label="Otra"], ' +
            '[aria-label="Otra"], ' +
            'div[role="checkbox"][aria-label="Otro"], ' +
            '[aria-label="Otro"], ' +
            '[data-testid*="grid-option"][aria-label="Otra"], ' +
            '[data-testid*="grid-option"][aria-label="Otro"], ' +
            'div[class*="dropdown__content"] [role="checkbox"]:has-text("Otra"), ' +
            'div[class*="dropdown__content"] [role="checkbox"]:has-text("Otro")'
          );

          if (otraDirect) {
            selected = await this.safeCheckOption(otraDirect, 'Otra / Otro', DETAIL_TIMEOUT);
          }
        }

        // 3. Если еще не выбран — проходим по всем доступным опциям в контейнерах
        if (!selected) {
          console.log('[VintedPublish] Size "%s" not found via direct selector, searching containers...', sizeQuery);

          for (const cSel of containerSelectors) {
            const options = await this.page.$$(
              `${cSel} div[role="checkbox"], ${cSel} [role="checkbox"], ${cSel} div[role="radio"], ${cSel} button[role="radio"], ${cSel} div[role="menuitem"], ${cSel} [role="option"], ${cSel} button`
            );
            if (options.length === 0) continue;

            // Приоритетно "Otra" / "Otro"
            for (const opt of options) {
              const text = (
                (await opt.getAttribute('aria-label').catch(() => '')) ||
                (await opt.innerText().catch(() => ''))
              ).toLowerCase().trim();

              if (/\botra(s)?\b/i.test(text) || /\botro(s)?\b/i.test(text)) {
                selected = await this.safeCheckOption(opt, text, DETAIL_TIMEOUT);
                break;
              }
            }
            if (selected) break;

            // Затем "Talla única" / "Única" / "Sin talla" / "Universal"
            for (const opt of options) {
              const text = (
                (await opt.getAttribute('aria-label').catch(() => '')) ||
                (await opt.innerText().catch(() => ''))
              ).toLowerCase().trim();

              if (text.includes('única') || text.includes('unica') || text.includes('sin talla') || text.includes('universal')) {
                selected = await this.safeCheckOption(opt, text, DETAIL_TIMEOUT);
                break;
              }
            }
            if (selected) break;

            // Если ничего из вышеперечисленного нет, выбираем первый интерактивный пункт размера (пропуская заголовки и подсказки)
            for (const opt of options) {
              const text = (
                (await opt.getAttribute('aria-label').catch(() => '')) ||
                (await opt.innerText().catch(() => ''))
              ).toLowerCase().trim();

              if (
                !text ||
                text.includes('tabla de tallas') ||
                text.includes('siguientes tallas') ||
                text.includes('mide el largo') ||
                text.includes('elige la talla') ||
                text.includes('guía de tallas') ||
                text.includes('atrás') ||
                text.includes('volver')
              ) {
                continue;
              }
              selected = await this.safeCheckOption(opt, text, DETAIL_TIMEOUT);
              break;
            }
            if (selected) break;
          }
        }

        // Если внизу диалога есть кнопка подтверждения ("Aceptar" / "Guardar" / "Aplicar")
        const confirmBtn = await this.page.$(
          'div[class*="Dialog__modal"] button:has-text("Aceptar"), ' +
          'div[class*="Dialog__modal"] button:has-text("Guardar"), ' +
          'div[class*="Dialog__modal"] button:has-text("Aplicar"), ' +
          'div[role="dialog"] button:has-text("Aceptar"), ' +
          'div[role="dialog"] button:has-text("Guardar")'
        );
        if (confirmBtn) {
          await confirmBtn.click({ timeout: DETAIL_TIMEOUT }).catch(() => null);
        }

        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      console.warn('[VintedPublish] Size selection failed:', e);
    } finally {
      if (opened) await this.page.keyboard.press('Escape').catch(() => null);
    }
  }

  private async fillDropdown(trigger: ElementHandle): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const menu = page.locator(`:is(${DROPDOWN_CONTENT}):visible`).first();
    let opened = false;

    try {
      if (await trigger.evaluate(hasDropdownValue)) return false;
      await trigger.click({ timeout: 3000 });
      opened = true;
      await menu.waitFor({ state: 'visible', timeout: 2000 });
      if (await this.hasCheckedChoice(menu)) return false;

      const option = menu.locator(`:is(${DROPDOWN_OPTION}):not(:disabled, [aria-disabled="true"]):visible`).first();
      if (await option.isVisible()) return await this.safeCheckOption(option, 'dynamic field option');

      const fallback = menu.locator(':is([role="menuitem"], button):not(:disabled, [aria-disabled="true"]):visible')
        .filter({ hasNotText: /^(?:atrás|volver|back|cerrar|close)$/i }).first();
      return await fallback.isVisible() && await this.safeCheckOption(fallback, 'dynamic field option');
    } catch (error) {
      console.warn('[VintedPublish] Dynamic field selection failed:', error);
      return false;
    } finally {
      if (opened && await menu.isVisible().catch(() => false)) await page.keyboard.press('Escape').catch(() => null);
    }
  }

  private async fillRemainingDynamicFields(): Promise<void> {
    if (!this.page) return;
    const known = [CATEGORY_INPUT, ...Object.values(DETAIL_INPUTS)].join(', ');
    const unselectedButtons = this.page.locator(`.select-wrapper button[aria-haspopup="menu"][data-placeholder=""]:not(:is(${known})):visible`);
    for (const button of await unselectedButtons.elementHandles()) {
      await this.fillDropdown(button);
    }
  }

  private async handlePackageSize(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const packageRadio = 'input[type="radio"]:is([name*="package_type_selector"], [name*="package_size"], [id^="package_type_selector"])';
      if (await this.page.locator(packageRadio + ':checked').count()) return false;
      const packageCells = this.page.locator(':is([data-testid$="package-size--cell"], [id^="package-size-"]):visible');
      if ((await Promise.all((await packageCells.all()).map(cell => this.isElementChecked(cell)))).some(Boolean)) return false;

      // Prefer the recommended or small option when no package size has been selected.
      // 1. Проверяем вариант с бейджем Recomendado
      const recommendedCell = await this.page.$(
        'div:has(span:has-text("Recomendado")) input[type="radio"], ' +
        'div:has-text("Recomendado") input[type="radio"], ' +
        '[data-testid*="package-size--cell"]:has-text("Recomendado"), ' +
        'label:has-text("Recomendado"), ' +
        'div[role="radio"]:has-text("Recomendado")'
      );
      if (recommendedCell) {
        await recommendedCell.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
        await recommendedCell.click();
        console.log('[VintedPublish] Selected "Recomendado" package size');
        return true;
      }

      // 2. Ищем размер "Pequeño"
      const smallCell = await this.page.$(
        '[data-testid="1-package-size--cell"], [data-testid="1-package-size--cell--suffix"], ' +
        '#package-size-1, label[for="package_type_selector_1"], [data-testid="package_type_selector_1"], ' +
        'div[data-testid*="package-size"]:has-text("Pequeño"), ' +
        'div:has-text("Pequeño") input[type="radio"], ' +
        'label:has-text("Pequeño"), ' +
        'div[role="radio"]:has-text("Pequeño")'
      );
      if (smallCell) {
        await smallCell.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
        await smallCell.click();
        console.log('[VintedPublish] Selected "Pequeño" package size');
        return true;
      }

      // 3. Если нет, берем первый радиобаттон размера (наименьший)
      const firstRadio = await this.page.$(packageRadio);
      if (firstRadio) {
        await firstRadio.click();
        console.log('[VintedPublish] Selected first available package size');
        return true;
      }
    } catch (e) {
      console.warn('[VintedPublish] handlePackageSize failed:', e);
    }
    return false;
  }

  private sanitizeCookiesFile(): void {
    if (!fs.existsSync(COOKIES_PATH)) return;
    try {
      const rawData = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      const cookiesList: any[] = rawData.cookies || [];

      // Find authentic user token (scope: "user")
      const userToken = cookiesList.find(
        (c) =>
          c.name === 'access_token_web' &&
          c.value?.startsWith('ey') &&
          (() => {
            try {
              const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
              return p.scope === 'user';
            } catch {
              return false;
            }
          })()
      );

      const vUidCookie = cookiesList.find((c) => c.name === 'v_uid');
      const vSidCookie = cookiesList.find((c) => c.name === 'v_sid');

      const cleanedCookies = cookiesList.filter((c) => {
        if (c.name === 'access_token_web' && userToken) {
          try {
            const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
            if (p.scope === 'public') return false;
          } catch {}
        }
        return true;
      });

      const domains = ['.vinted.es', 'www.vinted.es', '.vinted.com', 'www.vinted.com'];
      if (userToken) {
        for (const d of domains) {
          cleanedCookies.push({ ...userToken, domain: d });
          if (vUidCookie) cleanedCookies.push({ ...vUidCookie, domain: d });
          if (vSidCookie) cleanedCookies.push({ ...vSidCookie, domain: d });
        }
      }

      rawData.cookies = cleanedCookies;
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(rawData, null, 2), 'utf-8');
      console.log('[VintedBrowser] Sanitized cookies in %s', COOKIES_PATH);
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
