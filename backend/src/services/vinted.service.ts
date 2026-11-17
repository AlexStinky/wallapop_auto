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

      // 5. Brand (if any)
      if (product.brand) {
        await this.selectBrand(product.brand);
      }

      // 6. Condition
      await this.selectCondition(product.condition);

      // 7. Size (if provided or required)
      if (product.vintedSize) {
        await this.selectSize(product.vintedSize);
      }

      // 8. Price: Use vintedPrice if provided, else standard price
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

      // 9. Package size / Shipping (Vinted usually selects standard small/medium by default or offers options)
      await this.handlePackageSize();

      // Wait after photo uploads for Vinted processing & anti-spam cooldown
      await this.page.waitForTimeout(4000);

      // 10. Submit form ("Subir" / "Añadir")
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

        // Try exact match or fallback category (Hogar, Electrónica, etc.)
        const mainCat = categoryName || 'Hogar';
        let option = await this.page.$(`text="${mainCat}"`);
        if (!option) {
          // If custom category not matched, fallback to Hogar
          option = await this.page.$('text="Hogar"');
        }

        if (option) {
          await option.click();
          await this.page.waitForTimeout(600);

          if (subcategoryName) {
            const subOption = await this.page.$(`text="${subcategoryName}"`);
            if (subOption) {
              await subOption.click();
              await this.page.waitForTimeout(500);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[VintedPublish] Category selection skipped or failed:', e);
    }
  }

  private async selectBrand(brand: string): Promise<void> {
    if (!this.page || !brand) return;
    try {
      const brandTrigger = await this.page.$(
        'input[placeholder*="marca" i], [data-testid="brand_id"], text="Marca"'
      );
      if (brandTrigger) {
        await brandTrigger.click();
        await this.page.waitForTimeout(500);

        const searchInput = await this.page.$('input[placeholder*="marca" i], input[type="search"]');
        if (searchInput) {
          await searchInput.fill(brand);
          await this.page.waitForTimeout(800);
          const matchItem = await this.page.$(`[data-testid*="brand-item"]:has-text("${brand}"), div[role="listbox"] div:has-text("${brand}")`);
          if (matchItem) {
            await matchItem.click();
          }
        }
      }
    } catch (e) {
      console.warn('[VintedPublish] Brand selection skipped or failed:', e);
    }
  }

  private async selectCondition(wallapopCondition: string): Promise<void> {
    if (!this.page) return;
    try {
      const conditionMap: Record<string, string> = {
        new: 'Nuevo con etiquetas',
        used_like_new: 'En muy buen estado',
        used_good: 'Bueno',
        used_fair: 'Aceptable',
        poor: 'Aceptable',
      };
      const textToLook = conditionMap[wallapopCondition] || 'Bueno';

      // Open condition dropdown/selector if needed
      const trigger = await this.page.$('text="Estado"');
      if (trigger) {
        await trigger.click().catch(() => null);
        await this.page.waitForTimeout(500);
      }

      const option = await this.page.$(`label:has-text("${textToLook}"), div:has-text("${textToLook}")`);
      if (option) {
        await option.click();
      }
    } catch (e) {
      console.warn('[VintedPublish] Condition selection failed:', e);
    }
  }

  private async selectSize(size: string): Promise<void> {
    if (!this.page || !size) return;
    try {
      const sizeTrigger = await this.page.$('text="Talla"');
      if (sizeTrigger) {
        await sizeTrigger.click();
        await this.page.waitForTimeout(500);
        const sizeOption = await this.page.$(`text="${size}"`);
        if (sizeOption) {
          await sizeOption.click();
        }
      }
    } catch (e) {
      console.warn('[VintedPublish] Size selection failed:', e);
    }
  }

  private async handlePackageSize(): Promise<void> {
    if (!this.page) return;
    try {
      // By default Vinted selects a parcel size (Pequeño, Mediano, Grande)
      // If none selected, click 'Pequeño' or 'Mediano'
      const parcelOption = await this.page.$('label:has-text("Pequeño"), label:has-text("Mediano")');
      if (parcelOption) {
        await parcelOption.click();
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
