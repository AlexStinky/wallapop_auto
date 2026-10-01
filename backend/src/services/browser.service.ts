import { Browser, BrowserContext, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Product } from '@prisma/client';
import { PublishResult } from '../types';

const COOKIES_PATH = path.join(process.cwd(), '.session-cookies.json');
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class BrowserService {
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
      // Prefer real Google Chrome on system if available to avoid bot detection
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
      // Load saved cookies if they exist
      storageState: fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : undefined,
    });

    // Mask webdriver and automation flags
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
    console.log('[Browser] Initialized (headless=%s, desktop)', headless);
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
          // Format from Cookie-Editor / EditThisCookie extension
          cookies = parsed.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'wallapop.com'}`,
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
          // Playwright storageState format
          cookies = parsed.cookies;
          origins = parsed.origins || [];
        }
      } else {
        // Raw cookie header string: "cookie1=val1; cookie2=val2"
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
                domain: '.wallapop.com',
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
      console.log('[Browser] Imported %d cookies into %s', cookies.length, COOKIES_PATH);
      return { success: true, count: cookies.length };
    } catch (err: any) {
      console.error('[Browser] importCookies error:', err);
      return { success: false, count: 0, error: err.message || 'Помилка розбору кукі' };
    }
  }

  async openBrowserForManualLogin(maxWaitMs = 180000): Promise<{ success: boolean; message: string }> {
    try {
      if (this.browser) {
        await this.close();
      }

      console.log('[Browser] Opening browser for manual login...');
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
      await this.page.goto('https://es.wallapop.com/auth/onboarding', { waitUntil: 'domcontentloaded' });
      await this.acceptCookies(this.page);

      console.log('[Browser] Waiting for user to complete manual login (max %ds)...', maxWaitMs / 1000);
      const startTime = Date.now();
      let loggedIn = false;

      while (Date.now() - startTime < maxWaitMs) {
        await this.page.waitForTimeout(3000);
        if (!this.browser || !this.page || this.page.isClosed()) {
          console.log('[Browser] Browser window closed');
          break;
        }

        const currentUrl = this.page.url();
        if (
          currentUrl.includes('es.wallapop.com') &&
          !currentUrl.includes('/auth/') &&
          !currentUrl.includes('onboarding') &&
          !currentUrl.includes('login') &&
          !currentUrl.includes('accounts.wallapop.com')
        ) {
          loggedIn = true;
          console.log('[Browser] Detected successful login! URL: %s', currentUrl);
          await this.randomDelay(2000, 3000);
          break;
        }
      }

      if (this.context) {
        await this.context.storageState({ path: COOKIES_PATH });
        console.log('[Browser] Saved session cookies to %s', COOKIES_PATH);
      }

      await this.close();
      return {
        success: loggedIn,
        message: loggedIn
          ? 'Авторизація успішна! Сесія збережена.'
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
      // Saving state is best-effort
    }
    await this.page?.close().catch(() => null);
    await this.context?.close().catch(() => null);
    await this.browser?.close().catch(() => null);
    this.page = null;
    this.context = null;
    this.browser = null;
    console.log('[Browser] Closed');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async ensurePage(): Promise<Page> {
    if (!this.browser || !this.context) {
      await this.initialize(this.isHeadless);
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context!.newPage();
      await this.page.bringToFront().catch(() => null);
    }
    return this.page;
  }

  private getPage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('Browser not initialized. Call initialize() first.');
    return this.page;
  }

  private async randomDelay(minMs = 800, maxMs = 2500): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs);
    await this.getPage().waitForTimeout(ms);
  }

  private async screenshot(label: string): Promise<void> {
    try {
      const dir = path.join(process.cwd(), 'debug-screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${label}.png`);
      await this.getPage().screenshot({ path: file, fullPage: true });
      console.log('[Browser] Screenshot saved: %s', file);
    } catch (_) {
      // Non-critical
    }
  }

  // ─── Popups & Cookies ────────────────────────────────────────────────────────

  private async acceptCookies(page: Page): Promise<boolean> {
    try {
      const cookieSelectors = [
        '#cmpbntyestxt',
        '.cmpboxbtnyes',
        'a.cmpboxbtnyes',
        '#cmpwelcomebox a.cmpboxbtn',
        'a.cmpboxbtn',
        '#didomi-notice-agree-button',
        'button#didomi-notice-agree-button',
        '#onetrust-accept-btn-handler',
        'button:has-text("Aceptar todo")',
        'a:has-text("Aceptar todo")',
        'button:has-text("Aceptar todas")',
        'button:has-text("Aceptar")',
        'a:has-text("Aceptar")',
        'button:has-text("Rechazar todo")',
        'a:has-text("Rechazar todo")',
        '[id*="accept-cookie"]',
        '[data-testid*="cookie-accept"]',
      ];

      for (const sel of cookieSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log('[Browser] Accepting cookies via: %s', sel);
          await btn.click({ force: true }).catch(() => null);
          await this.randomDelay(800, 1500);
          return true;
        }
      }

      // Check all frames (in case ConsentManager is rendered inside an iframe)
      for (const frame of page.frames()) {
        for (const sel of cookieSelectors) {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log('[Browser] Accepting cookies inside frame via: %s', sel);
            await btn.click({ force: true }).catch(() => null);
            await this.randomDelay(800, 1500);
            return true;
          }
        }
      }

      // Fallback via getByText
      const textBtn = page.getByText('Aceptar todo', { exact: false }).first();
      if (await textBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('[Browser] Accepting cookies via getByText');
        await textBtn.click({ force: true }).catch(() => null);
        await this.randomDelay(800, 1500);
        return true;
      }
    } catch (_) {
      // Ignore
    }
    return false;
  }

  private async dismissPopups(page: Page): Promise<void> {
    try {
      const dismissSelectors = [
        'button:has-text("Ahora no")',
        'button:has-text("No, gracias")',
        'button:has-text("Rechazar")',
        'button[aria-label="Cerrar"]',
        'button[aria-label="Close"]',
        '[data-testid="close-button"]',
        '.modal-close',
        'button:has-text("Continuar en la web")',
        'button:has-text("Seguir en la web")',
      ];

      for (const sel of dismissSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          // Do not dismiss error toasts or alerts!
          const isErrorAlert = await btn
            .evaluate((el) => {
              const alertBox = el.closest(
                '[role="alert"], [role="alertdialog"], [class*="error" i], [class*="danger" i], [class*="toast" i], [class*="snackbar" i], walla-toast, walla-snackbar, walla-banner, ts-snackbar, ts-toast'
              );
              return Boolean(alertBox);
            })
            .catch(() => false);

          if (isErrorAlert) {
            console.log('[Browser] Skipping dismiss for error/alert popup button: %s', sel);
            continue;
          }

          console.log('[Browser] Dismissing popup: %s', sel);
          await btn.click({ force: true }).catch(() => null);
          await this.randomDelay(300, 600);
        }
      }

    } catch (_) {
      // Ignore
    }
  }

  private async selectEstandarShipping(page: Page): Promise<boolean> {
    try {
      console.log('[Browser] Checking for "Tamaño del producto" (Estándar vs Voluminoso) shipping section...');

      // 1. Check if the block is present on the page via selector
      const standardSelector = page
        .locator('input#delivery, walla-radio[arialabel="delivery"], #standardDescription1, #standardShippingIcon')
        .first();

      const isVisible = await standardSelector.isVisible({ timeout: 2500 }).catch(() => false);
      const isPresentInDom = isVisible || await page.evaluate(() => {
        return Boolean(document.querySelector('input#delivery, walla-radio[arialabel="delivery"], #standardDescription1, #itemSizeTitle'));
      }).catch(() => false);

      if (!isPresentInDom) {
        console.log('[Browser] Estándar shipping block not detected on page.');
        return false;
      }

      console.log('[Browser] Found Estándar shipping block. Ensuring "Estándar" (#delivery) is selected...');
      await standardSelector.scrollIntoViewIfNeeded().catch(() => null);

      // 2. Select via deep DOM evaluation
      const selected = await page.evaluate(() => {
        function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
          let results = Array.from(root.querySelectorAll(selector));
          const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Element;
            if (node.shadowRoot) {
              results = results.concat(queryAllDeep(selector, node.shadowRoot));
            }
          }
          return results;
        }

        const deliveryRadio = (document.querySelector('input#delivery') ||
          queryAllDeep('input#delivery')[0] ||
          queryAllDeep('walla-radio[arialabel="delivery"] input[type="radio"]')[0]) as HTMLInputElement | null;

        const deliveryWrapper = (document.querySelector('walla-radio[arialabel="delivery"]') ||
          queryAllDeep('walla-radio[arialabel="delivery"]')[0]) as HTMLElement | null;

        const standardText = document.querySelector('#standardDescription1') as HTMLElement | null;
        const standardIcon = document.querySelector('#standardShippingIcon') as HTMLElement | null;

        if (deliveryRadio && deliveryRadio.checked) {
          return true; // Already selected
        }

        // Trigger clicks on text, icon, and web component host
        if (standardText) standardText.click();
        if (standardIcon) standardIcon.click();
        if (deliveryWrapper) deliveryWrapper.click();

        if (deliveryRadio) {
          deliveryRadio.checked = true;
          deliveryRadio.click();
          deliveryRadio.dispatchEvent(new Event('input', { bubbles: true }));
          deliveryRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return true;
      }).catch(() => false);

      // 3. Playwright click fallback directly on the radio wrapper or input
      try {
        const radio = page.locator('walla-radio[arialabel="delivery"], input#delivery, #standardDescription1').first();
        if (await radio.isVisible().catch(() => false)) {
          await radio.click({ force: true }).catch(() => null);
        }
      } catch (_) {}

      console.log('[Browser] "Estándar" selected. Waiting for weight/size options to appear...');
      await this.randomDelay(1500, 2500);
      return selected;
    } catch (e) {
      console.warn('[Browser] Error selecting Estándar:', e);
      return false;
    }
  }

  private async selectCondition(page: Page, rawCondition: string): Promise<boolean> {
    try {
      console.log('[Browser] [Estado] Attempting to select condition: %s...', rawCondition);

      const conditionMap: Record<string, string[]> = {
        new: ['Nuevo', 'Sin abrir', 'Precintado', 'New'],
        nuevo: ['Nuevo', 'Sin abrir', 'Precintado', 'New'],
        like_new: ['Como nuevo', 'En perfecto estado', 'Like new'],
        used_like_new: ['Como nuevo', 'En perfecto estado', 'Like new'],
        'como nuevo': ['Como nuevo', 'En perfecto estado', 'Like new'],
        good: ['En buen estado', 'Buen estado', 'Good condition', 'Good'],
        used_good: ['En buen estado', 'Buen estado', 'Good condition', 'Good'],
        'en buen estado': ['En buen estado', 'Buen estado', 'Good condition', 'Good'],
        fair: ['Aceptable', 'Con marcas de uso', 'Fair'],
        used_fair: ['Aceptable', 'Con marcas de uso', 'Fair'],
        aceptable: ['Aceptable', 'Con marcas de uso', 'Fair'],
        poor: ['Lo ha dado todo', 'Para piezas', 'No funciona', 'For parts'],
        'para piezas': ['Lo ha dado todo', 'Para piezas', 'No funciona', 'For parts'],
        'lo ha dado todo': ['Lo ha dado todo', 'Para piezas', 'No funciona', 'For parts'],
      };

      const conditionIndexMap: Record<string, number> = {
        new: 0,
        nuevo: 0,
        like_new: 1,
        used_like_new: 1,
        como_nuevo: 1,
        'como nuevo': 1,
        good: 2,
        used_good: 2,
        en_buen_estado: 2,
        'en buen estado': 2,
        fair: 3,
        used_fair: 3,
        aceptable: 3,
        poor: 4,
        para_piezas: 4,
        'para piezas': 4,
        lo_ha_dado_todo: 4,
        'lo ha dado todo': 4,
      };

      const normKey = (rawCondition || '').toLowerCase().trim();
      const conditionLabels = conditionMap[normKey] ?? ['Como nuevo', 'En buen estado', 'Nuevo'];
      const targetIndex = conditionIndexMap[normKey] ?? 1;

      // Blur active element to commit any text input and let UI settle
      await page.evaluate(() => {
        if (document.activeElement && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }).catch(() => null);
      await this.randomDelay(300, 600);

      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log('[Browser] [Estado] Selection attempt %d of 2...', attempt);

        // ── Phase 1: Check if options or native select are already directly available on page
        const directSelected = await page.evaluate(({ labels, targetIdx }: { labels: string[]; targetIdx: number }) => {
          function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
            let results = Array.from(root.querySelectorAll(selector));
            const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const node = walker.currentNode as Element;
              if (node.shadowRoot) {
                results = results.concat(queryAllDeep(selector, node.shadowRoot));
              }
            }
            return results;
          }

          // Native <select> check
          const selects = queryAllDeep('select') as HTMLSelectElement[];
          for (const sel of selects) {
            const lbl = (sel.closest('label, div, fieldset')?.textContent || '') + ' ' + (sel.name || '') + ' ' + (sel.id || '');
            if (/\bestado\b/i.test(lbl) || /\bcondition\b/i.test(lbl)) {
              for (let i = 0; i < sel.options.length; i++) {
                const optText = (sel.options[i].text || '').toLowerCase();
                if (labels.some(l => optText.includes(l.toLowerCase()))) {
                  sel.selectedIndex = i;
                  sel.dispatchEvent(new Event('input', { bubbles: true }));
                  sel.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
              }
              if (sel.options.length > targetIdx + 1) {
                sel.selectedIndex = targetIdx + 1; // +1 if 0 is placeholder
                sel.dispatchEvent(new Event('input', { bubbles: true }));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }

          // Direct visible radio / chips / cards check
          const containers = queryAllDeep('section, div, fieldset, [class*="section" i], [class*="field" i], [class*="group" i]') as HTMLElement[];
          const estadoContainer = containers.find(c => {
            const text = (c.textContent || '').trim();
            if (text.length > 800) return false;
            return /\bestado\b/i.test(text) && !/estados unidos/i.test(text);
          });

          if (estadoContainer) {
            const candidates = Array.from(
              estadoContainer.querySelectorAll(
                'walla-radio, input[type="radio"], button, [role="radio"], [role="button"], label, div[class*="chip" i], div[class*="pill" i], div[class*="card" i], div[class*="item" i]'
              )
            ) as HTMLElement[];

            for (const label of labels) {
              const match = candidates.find(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                return t === label.toLowerCase() || t.includes(label.toLowerCase());
              });
              if (match && (match.offsetParent !== null || match.offsetHeight > 0)) {
                match.scrollIntoView({ block: 'center' });
                match.click();
                const innerInp = match.querySelector('input') || (match.tagName.toLowerCase() === 'input' ? match as HTMLInputElement : null);
                if (innerInp) innerInp.click();
                return true;
              }
            }
          }

          return false;
        }, { labels: conditionLabels, targetIdx: targetIndex }).catch(() => false);

        if (directSelected) {
          console.log('[Browser] [Estado] Selected condition via direct visible option/select');
          await this.randomDelay(400, 800);
          return true;
        }

        // ── Phase 2: Find & Open Dropdown
        const dropdownLocator = page
          .locator('walla-dropdown, tsl-dropdown, walla-select, div[class*="dropdown" i]')
          .filter({ hasText: /\bEstado\b/i })
          .locator('div[role="button"], .walla-dropdown__inner-input, button, [class*="inner" i]')
          .or(page.locator('walla-dropdown[label*="estado" i], tsl-dropdown[label*="estado" i]').locator('div[role="button"], .walla-dropdown__inner-input, button, [class*="inner" i]'))
          .or(page.locator('[id*="condition" i], [name*="condition" i], [formcontrolname*="condition" i], [id*="estado" i]').locator('div[role="button"], .walla-dropdown__inner-input, button, [class*="inner" i]'))
          .or(
            page
              .locator('text=/\\bEstado\\b/i')
              .locator('xpath=ancestor::*[contains(@class, "dropdown") or contains(@class, "field") or contains(@class, "cell") or contains(@class, "col") or self::walla-dropdown or self::tsl-dropdown][1]//div[@role="button" or contains(@class, "inner")] | ..//div[@role="button"]')
          )
          .first();

        if (await dropdownLocator.isVisible({ timeout: 2500 }).catch(() => false)) {
          console.log('[Browser] [Estado] Clicking dropdown via locator...');
          await dropdownLocator.scrollIntoViewIfNeeded().catch(() => null);
          await dropdownLocator.click({ force: true }).catch(() => null);
        }

        // Check if options appeared or if we need deep DOM trigger
        const optionsLocator = page.locator('walla-dropdown-item, tsl-dropdown-item, [role="option"], walla-floating-area:not([class*="hidden"]) *').first();
        const optionsVisible = await optionsLocator.isVisible({ timeout: 1200 }).catch(() => false);

        if (!optionsVisible) {
          console.log('[Browser] [Estado] Dropdown options not visible yet, triggering deep DOM click...');
          await page.evaluate(() => {
            function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
              let results = Array.from(root.querySelectorAll(selector));
              const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
              while (walker.nextNode()) {
                const node = walker.currentNode as Element;
                if (node.shadowRoot) {
                  results = results.concat(queryAllDeep(selector, node.shadowRoot));
                }
              }
              return results;
            }

            const dropdowns = queryAllDeep('walla-dropdown, tsl-dropdown, walla-select, [class*="dropdown" i]') as HTMLElement[];
            for (const d of dropdowns) {
              const lbl = (d.getAttribute('label') || '').toLowerCase();
              const txt = (d.textContent || '').trim().toLowerCase();
              const id = (d.getAttribute('id') || '').toLowerCase();
              const name = (d.getAttribute('name') || '').toLowerCase();
              if (
                lbl.includes('estado') ||
                id.includes('estado') ||
                id.includes('condition') ||
                name.includes('estado') ||
                name.includes('condition') ||
                (/\bestado\b/i.test(txt) && !txt.includes('marca') && !txt.includes('color') && !txt.includes('categoría'))
              ) {
                const btn = (d.querySelector('div[role="button"], .walla-dropdown__inner-input, button, [class*="inner" i]') as HTMLElement) || d;
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return true;
              }
            }

            const allElements = queryAllDeep('*') as HTMLElement[];
            const labelEl = allElements.find((el) => {
              if (el.children.length > 3) return false;
              const t = (el.textContent || '').trim();
              return /\bestado\b/i.test(t) && !/estados unidos/i.test(t) && t.length < 50;
            });

            if (labelEl) {
              let p: HTMLElement | null = labelEl.parentElement;
              for (let i = 0; i < 5 && p; i++) {
                const btn = p.querySelector('div[role="button"], button, .walla-dropdown__inner-input, [class*="inner" i], [class*="select" i]') as HTMLElement;
                if (btn) {
                  btn.scrollIntoView({ block: 'center' });
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  return true;
                }
                if (p.tagName.toLowerCase().includes('dropdown') || p.getAttribute('role') === 'button') {
                  p.scrollIntoView({ block: 'center' });
                  p.click();
                  return true;
                }
                p = p.parentElement;
              }
            }
            return false;
          }).catch(() => false);

          await this.randomDelay(600, 1000);
        }

        // ── Phase 3: Select Condition Option
        let conditionSelected = false;

        // Try Playwright locators for visible dropdown items
        for (const label of conditionLabels) {
          const itemLocator = page
            .locator('walla-dropdown-item, tsl-dropdown-item, [role="option"], walla-floating-area walla-dropdown-item, li[role="option"]')
            .filter({ hasText: new RegExp(label, 'i') })
            .first();

          if (await itemLocator.isVisible({ timeout: 800 }).catch(() => false)) {
            console.log('[Browser] [Estado] Selecting condition option by label: %s', label);
            await itemLocator.scrollIntoViewIfNeeded().catch(() => null);
            await itemLocator.click({ force: true }).catch(() => null);
            conditionSelected = true;
            await this.randomDelay(400, 800);
            break;
          }
        }

        // If not selected via locator, use deep evaluate with text and index fallback
        if (!conditionSelected) {
          conditionSelected = await page.evaluate(
            ({ labels, targetIdx }: { labels: string[]; targetIdx: number }) => {
              function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
                let results = Array.from(root.querySelectorAll(selector));
                const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
                while (walker.nextNode()) {
                  const node = walker.currentNode as Element;
                  if (node.shadowRoot) {
                    results = results.concat(queryAllDeep(selector, node.shadowRoot));
                  }
                }
                return results;
              }

              const items = queryAllDeep(
                'walla-dropdown-item, tsl-dropdown-item, [role="option"], .walla-dropdown-item, walla-floating-area [role="button"], li[role="option"], li'
              ) as HTMLElement[];

              const visibleItems = items.filter(it => it.offsetParent !== null || it.offsetHeight > 0);
              const pool = visibleItems.length > 0 ? visibleItems : items;

              // 1. Text match
              for (const label of labels) {
                const target = pool.find((it) => {
                  const t = (it.textContent || '').trim().toLowerCase();
                  return t.includes(label.toLowerCase());
                });
                if (target) {
                  target.scrollIntoView({ block: 'center' });
                  target.click();
                  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  return true;
                }
              }

              // 2. Index match fallback
              if (pool.length > 0) {
                const safeIdx = Math.min(Math.max(0, targetIdx), pool.length - 1);
                const target = pool[safeIdx];
                if (target) {
                  target.scrollIntoView({ block: 'center' });
                  target.click();
                  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  return true;
                }
              }

              return false;
            },
            { labels: conditionLabels, targetIdx: targetIndex }
          ).catch(() => false);

          if (conditionSelected) {
            console.log('[Browser] [Estado] Selected condition via deep evaluate fallback');
            await this.randomDelay(400, 800);
          }
        }

        // Close dropdown overlay if still open
        await page.keyboard.press('Escape').catch(() => null);
        await this.randomDelay(300, 600);

        if (conditionSelected) {
          console.log('[Browser] [Estado] Condition successfully selected on attempt %d', attempt);
          return true;
        }

        console.warn('[Browser] [Estado] Condition selection attempt %d did not complete, retrying...', attempt);
        await this.randomDelay(800, 1500);
      }

      console.warn('[Browser] [Estado] Could not select condition after all attempts');
      return false;
    } catch (err: any) {
      console.warn('[Browser] [Estado] Error selecting condition:', err?.message || err);
      return false;
    }
  }

  private async setupErrorObserver(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        (window as any).__capturedPopups = (window as any).__capturedPopups || [];
        if ((window as any).__hasErrorObserver) return;
        (window as any).__hasErrorObserver = true;

        function isRedColor(colorStr: string): boolean {
          if (!colorStr) return false;
          const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (match) {
            const [_, r, g, b] = match.map(Number);
            return r >= 150 && r > g + 35 && r > b + 35;
          }
          if (colorStr.startsWith('#')) {
            const hex = colorStr.slice(1);
            if (hex.length === 6) {
              const r = parseInt(hex.slice(0, 2), 16);
              const g = parseInt(hex.slice(2, 4), 16);
              const b = parseInt(hex.slice(4, 6), 16);
              return r >= 150 && r > g + 35 && r > b + 35;
            }
          }
          return false;
        }

        function checkNode(node: Node) {
          if (node.nodeType !== 1) return;
          const el = node as HTMLElement;
          const text = (el.innerText || el.textContent || '').trim();
          if (!text || text.length < 2 || text.length > 500) return;

          // Never treat informational banners, bulky promos, NUEVO badge, or loading states as errors
          if (/^(nuevo|new)$/i.test(text) || /revisa la informaci|hemos rellenado|detalles por ti|cargando|subiendo|guardando|loading|espera|por favor|procesando|productos voluminosos|servicio de env[ií]o|incluye recogida|el coste del servicio|ni lo notar[aá]s|bulky|nuevo/i.test(text)) {
            return;
          }

          const style = window.getComputedStyle(el);
          const role = el.getAttribute('role') || '';
          const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('class') || '');
          const tag = el.tagName.toLowerCase();

          if (/bulky|shipping|header|info|help|badge/i.test(tag) || /bulky|shipping|header|info|help|badge/i.test(cls)) {
            return;
          }

          const isAlertRole = role === 'alert' || role === 'alertdialog';
          const isAlertTag = /toast|snackbar|alert|notification/.test(tag) && !/banner|bulky/i.test(tag);
          const isAlertCls = /toast|snackbar|danger|error/i.test(cls) && !/bulky|banner/i.test(cls);
          const isRedStyled = isRedColor(style.backgroundColor) || isRedColor(style.color) || isRedColor(style.borderColor);
          const isFloating = (style.position === 'fixed' || style.position === 'absolute') && parseInt(style.zIndex || '0', 10) >= 10;

          if (isAlertRole || isAlertTag || (isAlertCls && (isRedStyled || isFloating)) || (isRedStyled && isFloating)) {
            if (text.length > 2) {
              (window as any).__capturedPopups.push({
                text,
                tag,
                cls,
                time: Date.now(),
              });
            }
          }
        }

        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
              checkNode(node);
              if ((node as HTMLElement).querySelectorAll) {
                (node as HTMLElement).querySelectorAll('*').forEach(checkNode);
              }
            }
            if (m.type === 'attributes' && m.target) {
              checkNode(m.target);
            }
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
        });
      });
    } catch (_) {}
  }

  private async getRedPopupOrErrorText(page: Page): Promise<string | null> {
    try {
      const errorText = await page.evaluate(() => {
        function isRedColor(colorStr: string): boolean {
          if (!colorStr) return false;
          const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (match) {
            const [_, r, g, b] = match.map(Number);
            return r >= 150 && r > g + 35 && r > b + 35;
          }
          if (colorStr.startsWith('#')) {
            const hex = colorStr.slice(1);
            if (hex.length === 6) {
              const r = parseInt(hex.slice(0, 2), 16);
              const g = parseInt(hex.slice(2, 4), 16);
              const b = parseInt(hex.slice(4, 6), 16);
              return r >= 150 && r > g + 35 && r > b + 35;
            }
          }
          return false;
        }

        function cleanText(t: string): string {
          if (!t) return '';
          return t
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/\b(cerrar|close)\b/gi, '')
            .replace(/[✕✖✗×]/g, '')
            .trim();
        }

        function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
          let results = Array.from(root.querySelectorAll(selector));
          const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Element;
            if (node.shadowRoot) {
              results = results.concat(queryAllDeep(selector, node.shadowRoot));
            }
          }
          return results;
        }

        function isIgnoredMessage(t: string): boolean {
          if (!t) return true;
          const trimmed = t.trim();
          if (/^(nuevo|new|ok|cerrar|close|ver|ayuda)$/i.test(trimmed)) return true;
          return /revisa la informaci|hemos rellenado|detalles por ti|cargando|subiendo|guardando|loading|espera|por favor|procesando|productos voluminosos|servicio de env[ií]o|incluye recogida|el coste del servicio|ni lo notar[aá]s|bulky|\bnuevo\b/i.test(t);
        }

        // 1. Check real-time captured popups from MutationObserver (newest first)
        const captured = ((window as any).__capturedPopups || []) as Array<{ text: string; time: number }>;
        if (captured.length > 0) {
          const recent = [...captured].reverse();
          for (const c of recent) {
            const cleaned = cleanText(c.text);
            if (isIgnoredMessage(cleaned)) continue;
            if (cleaned.length > 3 && !/^(aceptar|continuar|guardar|publicar)$/i.test(cleaned)) {
              return cleaned;
            }
          }
        }

        // 2. Scan DOM (including shadow DOM) for visible popup / toast / snackbar / alert
        const popupSelectors = [
          'walla-toast',
          'walla-snackbar',
          'walla-alert',
          'ts-snackbar',
          'ts-toast',
          '[role="alert"]',
          '[role="alertdialog"]',
          '[aria-live="assertive"]',
          '[class*="toast" i]',
          '[class*="snackbar" i]',
          '[class*="alert" i]:not([class*="shipping" i]):not([class*="bulky" i])',
          '[class*="danger" i]',
          '[class*="error" i]',
          '[class*="feedback" i]',
        ];

        for (const sel of popupSelectors) {
          const elements = queryAllDeep(sel);
          for (const el of elements) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

            const text = cleanText((el as HTMLElement).innerText || el.textContent || '');
            if (!text || text.length < 3 || text.length > 500) continue;

            const bg = style.backgroundColor;
            const color = style.color;
            const cls = (el as HTMLElement).className || '';
            const hasDangerClass = /danger|error|alert/i.test(String(cls));
            const hasAlertRole = el.getAttribute('role') === 'alert';

            if (isRedColor(bg) || isRedColor(color) || hasDangerClass || hasAlertRole) {
              if (isIgnoredMessage(text)) continue;
              return text;
            }
          }
        }

        // 3. Check inline field validation errors (e.g. "Campo obligatorio")
        const allElements = queryAllDeep('*');
        const fieldErrors: string[] = [];
        const errorElements = allElements.filter((el) => {
          if (el.children.length > 0) return false;
          const text = (el.textContent || '').trim();
          if (!text || text.length > 80) return false;
          if (isIgnoredMessage(text)) return false;
          if (!/obligatorio|requerido|inv[aá]lido|error|falta|introduce/i.test(text)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none'
          );
        });

        for (const errEl of errorElements) {
          const errText = cleanText(errEl.textContent || '');
          if (isIgnoredMessage(errText)) continue;
          let parent = errEl.parentElement;
          let label = '';
          for (let i = 0; i < 4 && parent; i++) {
            const labelEl = parent.querySelector('label, [class*="label"], [class*="title"], h2, h3, h4, h5, span');
            if (labelEl && labelEl !== errEl) {
              const lt = cleanText(labelEl.textContent || '');
              if (lt && lt.length < 40 && !lt.includes(errText)) {
                label = lt;
                break;
              }
            }
            parent = parent.parentElement;
          }
          const fullErr = label ? `${label}: ${errText}` : errText;
          if (!fieldErrors.includes(fullErr)) {
            fieldErrors.push(fullErr);
          }
        }

        if (fieldErrors.length > 0) {
          const joined = fieldErrors.join(', ');
          if (isIgnoredMessage(joined)) return null;
          return joined;
        }

        return null;
      });

      if (errorText && /cargando|subiendo|guardando|loading|espera|por favor|procesando|productos voluminosos|servicio de env[ií]o|incluye recogida|el coste del servicio|ni lo notar[aá]s|\bnuevo\b/i.test(errorText)) {
        return null;
      }
      return errorText;
    } catch (_) {
      return null;
    }
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  async isLoggedIn(): Promise<boolean> {
    const page = this.getPage();
    try {
      await page.goto('https://es.wallapop.com/app/you', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.randomDelay(1500, 2500);
      await this.acceptCookies(page);
      await this.dismissPopups(page);

      const currentUrl = page.url();
      if (
        currentUrl.includes('/auth/') ||
        currentUrl.includes('login') ||
        currentUrl.includes('signin') ||
        currentUrl.includes('onboarding') ||
        currentUrl.includes('accounts.wallapop.com')
      ) {
        console.log('[Browser] isLoggedIn: false (redirected to: %s)', currentUrl);
        return false;
      }

      const hasLoginPrompt = await page
        .locator('text="Regístrate o inicia sesión", text="Inicia sesión o regístrate", button:has-text("Iniciar sesión")')
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (hasLoginPrompt) {
        console.log('[Browser] isLoggedIn: false (login prompt visible)');
        return false;
      }

      console.log('[Browser] isLoggedIn: true');
      return true;
    } catch (err) {
      console.error('[Browser] isLoggedIn error:', err);
      return false;
    }
  }

  async login(email: string, password: string): Promise<boolean> {
    const page = this.getPage();
    try {
      console.log('[Browser] Attempting login for %s', email);
      await page.goto('https://es.wallapop.com/auth/onboarding', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.randomDelay(1500, 2500);

      // Accept cookies & dismiss popups
      await this.acceptCookies(page);
      await this.dismissPopups(page);

      // Click "Iniciar sesión con email"
      console.log('[Browser] Looking for "Iniciar sesión con email"...');
      const emailBtn = page.getByText('Iniciar sesión con email', { exact: false }).first();
      const altBtn = page.locator('walla-button, button, a').filter({ hasText: /email/i }).first();

      if (await emailBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
        console.log('[Browser] Clicking "Iniciar sesión con email" via getByText');
        await emailBtn.click({ force: true });
        await this.randomDelay(2000, 3000);
      } else if (await altBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[Browser] Clicking "Iniciar sesión con email" via filter');
        await altBtn.click({ force: true });
        await this.randomDelay(2000, 3000);
      }

      await this.acceptCookies(page);
      await this.dismissPopups(page);

      // Fill username (Keycloak uses input#username / input[name="username"])
      const usernameField = page.locator('input#username, input[name="username"], input[type="email"]').first();
      await usernameField.waitFor({ state: 'visible', timeout: 20000 });
      console.log('[Browser] Filling username: %s', email);
      await usernameField.fill(email);
      await this.randomDelay(400, 800);

      // Fill password
      const passwordField = page.locator('input#password, input[name="password"]').first();
      await passwordField.waitFor({ state: 'visible', timeout: 10000 });
      console.log('[Browser] Filling password...');
      await passwordField.fill(password);
      await this.randomDelay(400, 800);

      // Submit
      const submitBtn = page
        .locator('button:has-text("Acceder a Wallapop"), button[type="submit"], input[type="submit"]')
        .first();
      if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('[Browser] Clicking submit button ("Acceder a Wallapop")...');
        await submitBtn.click();
      } else {
        console.log('[Browser] Submit button not found, pressing Enter...');
        await passwordField.press('Enter');
      }

      // Wait for redirect or user verification (up to 120s in visible mode)
      const maxWait = this.isHeadless ? 15000 : 120000;
      console.log('[Browser] Waiting for login completion (max %ds)...', maxWait / 1000);
      const startTime = Date.now();
      let success = false;

      while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(2500);
        const currentUrl = page.url();

        // If returned to es.wallapop.com and left accounts/auth
        if (
          currentUrl.includes('es.wallapop.com') &&
          !currentUrl.includes('/auth/') &&
          !currentUrl.includes('onboarding') &&
          !currentUrl.includes('login') &&
          !currentUrl.includes('accounts.wallapop.com')
        ) {
          success = true;
          break;
        }

        const blockedEl = page.locator('text="Inicio de sesión no disponible", text="no disponible"').first();
        if (await blockedEl.isVisible().catch(() => false)) {
          console.warn('[Browser] Wallapop blocked login: "Inicio de sesión no disponible". Manual login or cookie import required.');
          break;
        }

        const errorEl = page.locator('.alert-error, [data-testid*="error"], #input-error-password, #input-error-username').first();
        if (await errorEl.isVisible().catch(() => false)) {
          const errText = await errorEl.textContent().catch(() => '');
          if (errText) {
            console.warn('[Browser] Login error message on page: %s', errText.trim());
          }
        }
      }

      if (success) {
        // Persist session
        await this.randomDelay(2000, 3000);
        await this.context!.storageState({ path: COOKIES_PATH });
        console.log('[Browser] Login successful, session saved to %s', COOKIES_PATH);
      } else {
        console.warn('[Browser] Login appears to have failed or requires verification');
        await this.screenshot('login-failed');
      }
      return success;
    } catch (err) {
      console.error('[Browser] Login error:', err);
      await this.screenshot('login-error');
      return false;
    }
  }

  // ─── Publishing ──────────────────────────────────────────────────────────────

  async publishProduct(product: Product): Promise<PublishResult> {
    const page = await this.ensurePage();
    let lastNetworkError: string | null = null;
    const responseListener = async (res: any) => {
      try {
        const url = res.url();
        if (res.status() >= 400 && (url.includes('wallapop.com/api') || url.includes('/catalog') || url.includes('/items'))) {
          const text = await res.text().catch(() => '');
          try {
            const json = JSON.parse(text);
            const errMsg = json.message || json.error || json.title || json.detail || (json.errors && JSON.stringify(json.errors));
            if (errMsg) {
              console.warn('[Browser] Captured API error response (%d %s): %s', res.status(), url, errMsg);
              lastNetworkError = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
            }
          } catch (_) {
            if (text && text.length < 300) {
              lastNetworkError = text;
            }
          }
        }
      } catch (_) {}
    };
    page.on('response', responseListener);

    try {
      console.log('[Browser] Publishing product: %s (%s)', product.id, product.title);

      // Parse images
      let images: string[] = [];
      try {
        images = JSON.parse(product.images) as string[];
      } catch (_) {
        images = [];
      }

      const uploadDir = process.env.UPLOAD_DIR || './uploads';

      // ── Navigate to upload page ──────────────────────────────────────────
      await page.goto('https://es.wallapop.com/app/catalog/upload', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.randomDelay(2000, 3000);
      await this.setupErrorObserver(page);

      // Dismiss cookie banner & any popups immediately
      await this.acceptCookies(page);
      await this.dismissPopups(page);

      // Handle possible login redirect
      if (
        page.url().includes('login') ||
        page.url().includes('signin') ||
        page.url().includes('/auth/') ||
        page.url().includes('onboarding')
      ) {
        console.warn('[Browser] Redirected to auth during publish — not logged in');
        await this.screenshot(`publish-not-logged-in-${product.id}`);
        return {
          success: false,
          error: 'Потрібна авторизація на Wallapop. Перевірте логін та пароль або виконайте вхід.',
        };
      }

      // ── Step 1: Select item type ("Algo que ya no necesito") ─────────────
      const itemTypeBtn = page
        .locator('text="Algo que ya no necesito", text="Algo que ya no uso", [data-testid*="consumer-goods"]')
        .or(page.getByText(/Algo que ya no/i))
        .first();
      await itemTypeBtn.waitFor({ state: 'visible', timeout: 15000 });
      console.log('[Browser] Selecting item type: Algo que ya no necesito');
      await itemTypeBtn.click();
      await this.randomDelay(1500, 2500);
      await this.acceptCookies(page);
      await this.dismissPopups(page);

      // ── Step 2: Product summary input ───────────────────────────────────
      console.log('[Browser] Waiting for summary input ("Resumen del producto")...');
      const summaryInput = page
        .locator('textarea')
        .or(page.getByPlaceholder(/Resumen/i))
        .or(page.locator('input[type="text"]').last())
        .first();
      await summaryInput.waitFor({ state: 'visible', timeout: 15000 });
      await summaryInput.scrollIntoViewIfNeeded();
      await summaryInput.click();
      // User explicit instruction: "в категории указывай только название категории, titulo не добавляй"
      let summaryText = '';
      if (product.subcategory && product.subcategory.trim() && product.subcategory.toLowerCase() !== 'auto') {
        summaryText = product.subcategory.trim().slice(0, 50);
      } else if (product.category && product.category.trim() && product.category.toLowerCase() !== 'auto') {
        summaryText = product.category.trim().slice(0, 50);
      } else {
        summaryText = product.title.trim().slice(0, 50);
      }
      console.log('[Browser] Filling summary: %s', summaryText);
      await summaryInput.fill(summaryText);
      await this.randomDelay(800, 1500);

      const continueSummary = page.getByRole('button', { name: /Continuar/i }).first();
      await continueSummary.waitFor({ state: 'visible', timeout: 5000 });
      console.log('[Browser] Clicking Continuar after summary...');
      await continueSummary.click();
      await this.randomDelay(2000, 3000);

      await this.acceptCookies(page);
      await this.dismissPopups(page);

      // ── Step 3: Upload images ────────────────────────────────────────────
      if (images.length > 0) {
        const absolutePaths = images
          .map((img) => {
            const basename = path.basename(img);
            const p = path.resolve(uploadDir, basename);
            if (fs.existsSync(p)) return p;
            const direct = path.resolve(img);
            if (fs.existsSync(direct)) return direct;
            return null;
          })
          .filter(Boolean) as string[];

        if (absolutePaths.length > 0) {
          console.log('[Browser] Uploading %d images...', absolutePaths.length);

          const fileInput = page.locator('input[type="file"]').first();
          await fileInput.waitFor({ state: 'attached', timeout: 15000 });
          await fileInput.setInputFiles(absolutePaths);
          console.log('[Browser] Images attached, waiting for preview...');
          await this.randomDelay(4000, 6000);

          // Click Continuar below photos
          const continueButtons = page.getByRole('button', { name: /Continuar/i });
          const count = await continueButtons.count();
          for (let i = count - 1; i >= 0; i--) {
            const btn = continueButtons.nth(i);
            if (await btn.isEnabled().catch(() => false)) {
              console.log('[Browser] Clicking Continuar after photo upload (index %d)...', i);
              await btn.click();
              await this.randomDelay(2000, 3000);
              break;
            }
          }
        }
      }

      await this.acceptCookies(page);
      await this.dismissPopups(page);

      // ── Step 4: Category & Subcategory selection ─────────────────────────
      console.log('[Browser] Checking Step 4: Category & Subcategory...');
      await this.randomDelay(1500, 2500);

      // Check if Wallapop already auto-selected a category and displayed details
      const formAlreadyVisible = await page
        .locator('input#title, input[name="title"], textarea#description')
        .or(page.getByText('Revisa la información'))
        .first()
        .isVisible()
        .catch(() => false);

      if (formAlreadyVisible) {
        console.log('[Browser] Category was auto-selected by Wallapop. Details form is already visible.');
      } else {
        // Open category dropdown
        const catDropdown = page
          .locator('walla-dropdown div[role="button"], walla-dropdown .walla-dropdown__inner-input, walla-dropdown')
          .first();

        if (await catDropdown.isVisible({ timeout: 8000 }).catch(() => false)) {
          console.log('[Browser] Opening category dropdown...');
          await catDropdown.scrollIntoViewIfNeeded();
          await catDropdown.click({ force: true });
          await this.randomDelay(1500, 2500);

          // Get suggested items
          const items = page.locator('walla-dropdown-item, [role="option"]');
          const itemCount = await items.count().catch(() => 0);
          console.log('[Browser] Found %d items in category dropdown', itemCount);

          let selected = false;
          if (itemCount > 0) {
            // Click the first suggested category
            const firstItem = items.first();
            const firstText = (await firstItem.textContent().catch(() => ''))?.trim().replace(/\s+/g, ' ');
            console.log('[Browser] Selecting suggested category: "%s"', firstText);
            await firstItem.scrollIntoViewIfNeeded();
            await firstItem.click({ force: true });
            await this.randomDelay(1500, 2500);
            selected = true;

            // Check if subcategories opened (dropdown remains open with subcategory items)
            const subcatItems = page.locator('walla-dropdown-item, [role="option"]');
            const subcatCount = await subcatItems.count().catch(() => 0);
            console.log('[Browser] Subcategory items count after first click: %d', subcatCount);

            if (subcatCount > 0) {
              const firstSubcat = subcatItems.first();
              const subcatText = (await firstSubcat.textContent().catch(() => ''))?.trim().replace(/\s+/g, ' ');
              console.log('[Browser] Selecting subcategory: "%s"', subcatText);
              await firstSubcat.scrollIntoViewIfNeeded();
              await firstSubcat.click({ force: true });
              await this.randomDelay(1500, 2500);
            }
          }

          if (!selected) {
            // Fallback: pick any category item
            const anyItem = page.locator('walla-dropdown-item, [role="option"], div[role="button"]').first();
            if (await anyItem.isVisible({ timeout: 2500 }).catch(() => false)) {
              await anyItem.click({ force: true });
              await this.randomDelay(1000, 2000);
            }
          }
        }
      }

      // Check if a "Continuar" button is present and enabled after category step
      const continueButtons = page.getByRole('button', { name: /Continuar/i });
      const countCatBtn = await continueButtons.count().catch(() => 0);
      for (let i = countCatBtn - 1; i >= 0; i--) {
        const btn = continueButtons.nth(i);
        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
          console.log('[Browser] Clicking Continuar after category (index %d)...', i);
          await btn.click({ force: true });
          await this.randomDelay(2000, 3000);
          break;
        }
      }

      // Wait for full product details form (Título*, Descripción*, etc.) to settle
      console.log('[Browser] Waiting for form fields to settle...');
      const formDetector = page
        .locator('input#title, input[name="title"], textarea#description')
        .or(page.getByText('Revisa la información'))
        .or(page.getByText('Detalles del producto'))
        .first();
      await formDetector.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
      await this.randomDelay(2000, 3000);
      await this.acceptCookies(page);
      await this.dismissPopups(page);
      await this.setupErrorObserver(page);

      // ── Step 5: Title (Título*) ──────────────────────────────────────────
      // User instruction: "в titulo нужно добавлять titulo"
      const titleInput = page
        .locator('input#title, input[name="title"], input[placeholder*="Título" i], input[placeholder*="Title" i]')
        .or(page.locator('text="Título*", text="Title*"').locator('xpath=ancestor::walla-text-input//input | ..//input'))
        .first();

      if (await titleInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await titleInput.scrollIntoViewIfNeeded();
        await titleInput.click({ force: true });
        await titleInput.press('Control+A');
        await titleInput.press('Backspace');
        console.log('[Browser] Filling title: %s', product.title);
        await titleInput.fill(product.title.slice(0, 50));
        await this.randomDelay(400, 800);
      } else {
        console.warn('[Browser] Title input not found on page');
      }

      // ── Step 6: Description (Descripción*) ──────────────────────────────
      // User instruction: "в description тоже"
      const descInput = page
        .locator('textarea#description, textarea[name="description"], textarea[placeholder*="descripción" i], textarea[placeholder*="description" i]')
        .or(page.locator('text="Descripción*", text="Description*"').locator('xpath=ancestor::walla-text-input//textarea | ..//textarea'))
        .first();

      if (await descInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await descInput.scrollIntoViewIfNeeded();
        await descInput.click({ force: true });
        await descInput.press('Control+A');
        await descInput.press('Backspace');
        console.log('[Browser] Filling description: %s...', product.description.slice(0, 40));
        await descInput.fill(product.description.slice(0, 640));
        await this.randomDelay(400, 800);
      } else {
        console.warn('[Browser] Description textarea not found on page');
      }

      // ── Step 7: Condition (Estado*) ──────────────────────────────────────
      await this.selectCondition(page, product.condition);

      // ── Step 7.2: Price (Precio*) ────────────────────────────────────────
      console.log('[Browser] Filling price: %s', product.price);
      let priceFilled = false;

      // Method 1: Target specifically via labels and localized field containers (excluding type="search")
      try {
        const priceInputLocator = page
          .getByLabel(/^Precio/i)
          .or(page.locator('label:has-text("Precio") ~ input, label:has-text("Precio") input'))
          .or(page.locator('[class*="price" i] input:not([type="search"]), [id*="price" i] input:not([type="search"])'))
          .or(
            page
              .locator('text=/^\\s*Precio\\s*\\*?\\s*$/i')
              .locator('xpath=ancestor::*[contains(@class, "field") or contains(@class, "input") or contains(@class, "cell") or contains(@class, "col") or contains(@class, "group")][1]//input[not(@type="search")]')
          )
          .first();

        if (await priceInputLocator.isVisible({ timeout: 4000 }).catch(() => false)) {
          await priceInputLocator.scrollIntoViewIfNeeded();
          await priceInputLocator.click({ force: true });
          await priceInputLocator.fill('');
          await priceInputLocator.pressSequentially(String(product.price), { delay: 40 });
          await priceInputLocator.press('Tab');
          console.log('[Browser] Filled price via locator: %s', product.price);
          priceFilled = true;
          await this.randomDelay(400, 800);
        }
      } catch (e) {
        console.warn('[Browser] Error with priceInputLocator:', e);
      }

      // Method 2: In-browser deep DOM evaluation (Shadow DOM + nearby element traversal)
      if (!priceFilled) {
        priceFilled = await page.evaluate((priceValue) => {
          function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
            let results = Array.from(root.querySelectorAll(selector));
            const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const node = walker.currentNode as Element;
              if (node.shadowRoot) {
                results = results.concat(queryAllDeep(selector, node.shadowRoot));
              }
            }
            return results;
          }

          const allElements = queryAllDeep('*');
          const labelEl = allElements.find((el) => {
            if (el.children.length > 2) return false;
            const t = (el.textContent || '').trim();
            return /^Precio\s*\*?$/i.test(t);
          });

          if (labelEl) {
            let parent: Element | null = labelEl.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
              const input = parent.querySelector('input:not([type="hidden"]):not([type="search"])') as HTMLInputElement | null;
              if (input) {
                input.scrollIntoView({ block: 'center' });
                input.focus();
                input.value = '';
                input.value = String(priceValue);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.blur();
                return true;
              }
              parent = parent.parentElement;
            }
          }

          // Fallback: look for input with currency symbol '€' or 'Precio' in its container
          const inputs = queryAllDeep('input:not([type="hidden"]):not([type="search"])') as HTMLInputElement[];
          for (const inp of inputs) {
            const parent = inp.closest('div, [class*="field"], [class*="input"], section');
            if (parent && /€|Precio/i.test(parent.textContent || '')) {
              inp.scrollIntoView({ block: 'center' });
              inp.focus();
              inp.value = String(priceValue);
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              inp.blur();
              return true;
            }
          }

          return false;
        }, product.price).catch(() => false);

        if (priceFilled) {
          console.log('[Browser] Filled price via evaluate DOM lookup: %s', product.price);
          await this.randomDelay(400, 800);
        } else {
          console.warn('[Browser] Price input could not be filled');
        }
      }

      // ── Step 7.5: Weight / Package Size / Shipping ("Elige un tamaño" / "¿Cuánto pesa?") ────
      const weightLabelsMap: Record<string, string[]> = {
        '0-1kg': ['0 a 1 kg', '0 - 1 kg', 'Hasta 2 kg', '0 a 2 kg', '0 - 2 kg', 'Pequeño', 'Pequeña', '1 a 2 kg', '1 - 2 kg'],
        '1-2kg': ['1 a 2 kg', '1 - 2 kg', 'Hasta 2 kg', '0 a 2 kg', '0 - 2 kg', '0 a 1 kg', 'Pequeño'],
        '2-5kg': ['2 a 5 kg', '2 - 5 kg', 'De 2 a 5 kg', 'Mediano', 'Mediana', '2-5 kg'],
        '5-10kg': ['5 a 10 kg', '5 - 10 kg', 'De 5 a 10 kg', 'Grande', '5-10 kg'],
        '10-20kg': ['10 a 20 kg', '10 - 20 kg', 'Extra grande', '10-20 kg'],
        '20-30kg': ['20 a 30 kg', '20 - 30 kg', 'De 20 a 30 kg', '20-30 kg'],
      };
      const weightIndexMap: Record<string, number> = {
        '0-1kg': 0,
        '1-2kg': 1,
        '2-5kg': 2,
        '5-10kg': 3,
        '10-20kg': 4,
        '20-30kg': 5,
      };

      const targetWeightLabels = weightLabelsMap[product.weight || ''] || [
        '0 a 1 kg',
        'Hasta 2 kg',
        '0 a 2 kg',
        'Pequeño',
        '1 a 2 kg',
        '2 a 5 kg',
      ];
      const targetWeightIndex = (product.weight && weightIndexMap[product.weight] !== undefined)
        ? weightIndexMap[product.weight]
        : 0;

      console.log('[Browser] Handling package size / weight: %s (preferred labels: %s, index: %d)',
        product.weight || 'default', targetWeightLabels.join(', '), targetWeightIndex);

      // Phase 0: Scroll down towards shipping / size section
      const shippingSectionEl = page
        .locator('#itemSizeTitle, #standardDescription1, input#delivery, text=/Tamaño del producto|Elige un tama[ñn]o|detalle necesario para activar la opci[oó]n de env[ií]o|Opciones de env[ií]o|¿Cu[aá]nto pesa\?|Tama[ñn]o del paquete/i')
        .first();
      if (await shippingSectionEl.isVisible({ timeout: 5000 }).catch(() => false)) {
        await shippingSectionEl.scrollIntoViewIfNeeded();
        await this.randomDelay(400, 700);
      }

      // Phase 1: FIRST choose "Estándar" if present ("в котором нужно выбрать Estándar после чего нужно выбрать вес")
      await this.selectEstandarShipping(page);

      // Phase 2: Check if "Elige un tamaño" or shipping dropdown needs to be clicked/opened first
      let sizeSelectorOpened = false;
      const sizeTrigger = page
        .locator('walla-dropdown')
        .filter({ hasText: /tama[ñn]o|env[ií]o|peso|cu[aá]nto pesa/i })
        .locator('div[role="button"], .walla-dropdown__inner-input, [class*="inner"]')
        .or(page.locator('walla-dropdown[label*="tamaño" i], walla-dropdown[label*="envío" i], walla-dropdown[label*="peso" i]').locator('div[role="button"], .walla-dropdown__inner-input, [class*="inner"]'))
        .or(page.locator('text=/Elige un tama[ñn]o/i'))
        .or(page.locator('text=/detalle necesario para activar la opci[oó]n de env[ií]o/i'))
        .first();

      if (await sizeTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[Browser] Clicking "Elige un tamaño" / shipping selector to open options...');
        await sizeTrigger.scrollIntoViewIfNeeded();
        await sizeTrigger.click({ force: true }).catch(() => null);
        sizeSelectorOpened = true;
        await this.randomDelay(800, 1500);
      } else {
        // Deep search for clickable element containing "Elige un tamaño"
        sizeSelectorOpened = await page.evaluate(() => {
          function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
            let results = Array.from(root.querySelectorAll(selector));
            const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const node = walker.currentNode as Element;
              if (node.shadowRoot) {
                results = results.concat(queryAllDeep(selector, node.shadowRoot));
              }
            }
            return results;
          }

          const allEls = queryAllDeep('*');
          for (const el of allEls) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (txt.includes('elige un tamaño') || txt.includes('activar la opción de envío')) {
              // Click container or button
              const btn = (el.closest('walla-dropdown, div[role="button"], button, [class*="card"], [class*="cell"], [class*="row"]') as HTMLElement) || (el as HTMLElement);
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (sizeSelectorOpened) {
          console.log('[Browser] Deep-clicked "Elige un tamaño" element.');
          await this.randomDelay(800, 1500);
        }
      }

      // Phase 3: Select the target size/weight option
      let sizeSelected = false;

      // 3A: Playwright locators for open dropdown / modal / bottom-sheet items
      for (const label of targetWeightLabels) {
        const optionEl = page
          .locator('walla-floating-area:not([class*="hidden"]) walla-dropdown-item, walla-dropdown-item, [role="option"], [role="radio"], .walla-dropdown-item')
          .filter({ hasText: new RegExp(label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') })
          .or(page.getByText(label, { exact: false }))
          .first();

        if (await optionEl.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log('[Browser] Found size/weight option: "%s"', label);
          await optionEl.scrollIntoViewIfNeeded();
          await optionEl.click({ force: true });
          sizeSelected = true;
          await this.randomDelay(500, 900);
          break;
        }
      }

      // 3B: If radio button is present
      if (!sizeSelected) {
        try {
          const radioNth = page.locator('input[type="radio"]').nth(targetWeightIndex);
          if (await radioNth.isVisible({ timeout: 1500 }).catch(() => false)) {
            await radioNth.scrollIntoViewIfNeeded();
            await radioNth.check({ force: true });
            console.log('[Browser] Checked radio input directly at index %d', targetWeightIndex);
            sizeSelected = true;
            await this.randomDelay(400, 800);
          }
        } catch (_) {}
      }

      // 3C: Deep shadow DOM traversal evaluate
      if (!sizeSelected) {
        sizeSelected = await page.evaluate(({ labels, index }: { labels: string[]; index: number }) => {
          function queryAllDeep(selector: string, root: Document | Element | ShadowRoot = document): Element[] {
            let results = Array.from(root.querySelectorAll(selector));
            const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const node = walker.currentNode as Element;
              if (node.shadowRoot) {
                results = results.concat(queryAllDeep(selector, node.shadowRoot));
              }
            }
            return results;
          }

          // Search in options, buttons, labels
          const candidates = queryAllDeep('walla-dropdown-item, [role="option"], [role="radio"], label, button, li, .walla-item');
          for (const label of labels) {
            const match = candidates.find((el) => {
              const t = (el.textContent || '').trim().toLowerCase();
              return t.includes(label.toLowerCase());
            });
            if (match) {
              (match as HTMLElement).scrollIntoView({ block: 'center' });
              (match as HTMLElement).click();
              match.parentElement?.click();
              return true;
            }
          }

          // If radios exist
          const radios = queryAllDeep('input[type="radio"]') as HTMLInputElement[];
          if (radios.length > index) {
            const r = radios[index];
            r.scrollIntoView({ block: 'center' });
            r.click();
            r.checked = true;
            r.dispatchEvent(new Event('change', { bubbles: true }));
            r.dispatchEvent(new Event('input', { bubbles: true }));
            r.closest('label')?.click();
            return true;
          }

          // Or any element containing weight string
          const all = queryAllDeep('*');
          for (const label of labels) {
            const el = all.find((e) => {
              if (e.children.length > 2) return false;
              const t = (e.textContent || '').trim().toLowerCase();
              return t === label.toLowerCase() || t.startsWith(label.toLowerCase());
            });
            if (el) {
              (el as HTMLElement).scrollIntoView({ block: 'center' });
              (el as HTMLElement).click();
              el.parentElement?.click();
              return true;
            }
          }
          return false;
        }, { labels: targetWeightLabels, index: targetWeightIndex }).catch(() => false);

        if (sizeSelected) {
          console.log('[Browser] Deep-selected size option successfully.');
          await this.randomDelay(500, 900);
        }
      }

      // Phase 4: If there is an "Aplicar" / "Guardar" / "Aceptar" button in the modal/sheet, click it
      const modalConfirmBtn = page
        .locator('walla-dialog, walla-modal, [class*="modal"], [class*="drawer"], [class*="sheet"], walla-floating-area')
        .locator('button:has-text("Guardar"), button:has-text("Aplicar"), button:has-text("Aceptar"), button:has-text("Confirmar")')
        .first();
      if (await modalConfirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log('[Browser] Clicking modal confirmation button for size selection...');
        await modalConfirmBtn.click({ force: true }).catch(() => null);
        await this.randomDelay(400, 800);
      }

      await this.randomDelay(800, 1500);

      // Ensure "Estándar" (#delivery) remains selected before clicking Publicar
      await this.selectEstandarShipping(page);

      // ── Step 8: Final Publish Button ──────────────────────────────────────
      await this.randomDelay(1000, 2000);
      const publishBtn = page
        .getByRole('button', { name: /^Publicar$/i })
        .or(page.locator('button:has-text("Publicar")'))
        .last();

      let clicked = false;
      if (await publishBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await publishBtn.scrollIntoViewIfNeeded();
        console.log('[Browser] Clicking final Publicar button...');
        await publishBtn.click({ force: true });
        clicked = true;
      }

      if (!clicked) {
        const popupErr = await this.getRedPopupOrErrorText(page);
        await this.screenshot(`publish-no-submit-${product.id}`);
        return { success: false, error: popupErr || lastNetworkError || 'Could not find publish button' };
      }

      // ── Wait for confirmation or red popup error ─────────────────────────
      console.log('[Browser] Waiting for publication confirmation or error popup...');
      const pollStart = Date.now();
      const maxWaitMs = 30000;
      let finalError: string | null = null;

      while (Date.now() - pollStart < maxWaitMs) {
        await page.waitForTimeout(600);

        // 1. Check if a real red popup / toast or validation error appeared (not "Cargando...", bulky promo or "NUEVO" badge)
        const errorPopup = await this.getRedPopupOrErrorText(page);
        if (
          errorPopup &&
          !/cargando|loading|subiendo|guardando|espera|procesando|productos voluminosos|servicio de env[ií]o|incluye recogida|el coste del servicio|ni lo notar[aá]s|\bnuevo\b|\bnew\b/i.test(
            errorPopup
          )
        ) {
          console.warn('[Browser] Detected error popup: "%s"', errorPopup);
          finalError = errorPopup;
          await page.waitForTimeout(800);
          await this.screenshot(`publish-error-${product.id}`);
          break;
        }

        if (lastNetworkError) {
          console.warn('[Browser] Detected network error: "%s"', lastNetworkError);
          finalError = lastNetworkError;
          await this.screenshot(`publish-network-error-${product.id}`);
          break;
        }

        // 2. Check for success URL
        const currentUrl = page.url();
        const itemUrlMatch =
          currentUrl.match(/wallapop\.com\/.*?(?:item|anuncio|app\/item|i)\/(\d+)/i) ||
          currentUrl.match(/wallapop\.com\/.*?\/(\d{8,})/);
        if (itemUrlMatch) {
          console.log('[Browser] Published successfully (item URL): %s', currentUrl);
          return { success: true, wallapopId: itemUrlMatch[1], url: currentUrl };
        }

        // 3. Check for success indicators
        const successEl = page
          .locator(
            '[data-testid="success-message"], [class*="success"], .toast-success, text="¡Enhorabuena!", text="Tu anuncio ha sido publicado", text="anuncio publicado", text="has publicado"'
          )
          .first();
        if (await successEl.isVisible().catch(() => false)) {
          const match = currentUrl.match(/\/(\d{5,})/);
          console.log('[Browser] Published successfully (via success indicator)');
          return { success: true, wallapopId: match ? match[1] : undefined, url: currentUrl };
        }

        // 4. Navigated away from upload page
        if (!currentUrl.includes('/app/catalog/upload') && !currentUrl.includes('/app/upload')) {
          console.log('[Browser] Navigated away from upload page, assuming published: %s', currentUrl);
          return { success: true, url: currentUrl };
        }
      }

      if (finalError) {
        return { success: false, error: finalError };
      }

      // Final check
      const lastCheckError = (await this.getRedPopupOrErrorText(page)) || lastNetworkError;
      if (
        lastCheckError &&
        !/cargando|loading|subiendo|guardando|espera|procesando|productos voluminosos|servicio de env[ií]o|incluye recogida|el coste del servicio|ni lo notar[aá]s|\bnuevo\b|\bnew\b/i.test(
          lastCheckError
        )
      ) {
        await this.screenshot(`publish-error-${product.id}`);
        return { success: false, error: lastCheckError };
      }

      await this.screenshot(`publish-ambiguous-${product.id}`);
      return {
        success: false,
        error: 'Помилка публікації на Wallapop: не вдалося підтвердити успіх. Перевірте обов\'язкові поля.',
      };
    } catch (err) {
      const popupErr = await this.getRedPopupOrErrorText(page).catch(() => null);
      const rawMsg = err instanceof Error ? err.message : String(err);
      const errorMsg = popupErr || lastNetworkError || rawMsg;
      console.error('[Browser] publishProduct error:', errorMsg);
      await this.screenshot(`publish-exception-${product.id}`);
      return { success: false, error: errorMsg };
    } finally {
      page.off('response', responseListener);
    }
  }
}

// Export singleton
export const browserService = new BrowserService();
export default browserService;
