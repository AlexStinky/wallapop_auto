"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.vintedBrowserService = exports.VintedBrowserService = void 0;
const playwright_1 = require("playwright");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const uploads_1 = require("../uploads");
const COOKIES_PATH = path.join(process.cwd(), '.vinted-cookies.json');
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
class VintedBrowserService {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isHeadless = true;
        this.hasRateLimit = false;
    }
    // ─── Lifecycle ──────────────────────────────────────────────────────────────
    async initialize(headless) {
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
            this.browser = await playwright_1.chromium.launch({
                headless,
                channel: 'chrome',
                args: launchArgs,
                ignoreDefaultArgs: ['--enable-automation'],
            });
        }
        catch (_) {
            this.browser = await playwright_1.chromium.launch({
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
                const cookiesList = rawData.cookies || [];
                // Find authentic user token (scope: "user")
                const userToken = cookiesList.find((c) => c.name === 'access_token_web' && c.value?.startsWith('ey') &&
                    (() => {
                        try {
                            const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
                            return p.scope === 'user';
                        }
                        catch {
                            return false;
                        }
                    })());
                const vUidCookie = cookiesList.find((c) => c.name === 'v_uid');
                const vSidCookie = cookiesList.find((c) => c.name === 'v_sid');
                // Remove any public/guest tokens that override authenticated sessions
                const cleanedCookies = cookiesList.filter((c) => {
                    if (c.name === 'access_token_web' && userToken) {
                        try {
                            const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
                            if (p.scope === 'public')
                                return false;
                        }
                        catch { }
                    }
                    return true;
                });
                // Ensure user token and v_uid/v_sid exist on .vinted.es, www.vinted.es, .vinted.com, www.vinted.com
                const domains = ['.vinted.es', 'www.vinted.es', '.vinted.com', 'www.vinted.com'];
                if (userToken) {
                    for (const d of domains) {
                        cleanedCookies.push({ ...userToken, domain: d });
                        if (vUidCookie)
                            cleanedCookies.push({ ...vUidCookie, domain: d });
                        if (vSidCookie)
                            cleanedCookies.push({ ...vSidCookie, domain: d });
                    }
                }
                await this.context.addCookies(cleanedCookies).catch(() => null);
            }
            catch (_) { }
        }
        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            window.chrome = window.chrome || {
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
    async importCookies(raw) {
        try {
            let cookies = [];
            let origins = [];
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
                        sameSite: c.sameSite === 'no_restriction'
                            ? 'None'
                            : c.sameSite === 'strict'
                                ? 'Strict'
                                : 'Lax',
                    }));
                }
                else if (parsed.cookies && Array.isArray(parsed.cookies)) {
                    cookies = parsed.cookies;
                    origins = parsed.origins || [];
                }
            }
            else {
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
        }
        catch (err) {
            console.error('[VintedBrowser] importCookies error:', err);
            return { success: false, count: 0, error: err.message || 'Помилка розбору кукі' };
        }
    }
    async openBrowserForManualLogin(maxWaitMs = 180000) {
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
                this.browser = await playwright_1.chromium.launch({
                    headless: false,
                    channel: 'chrome',
                    args: launchArgs,
                    ignoreDefaultArgs: ['--enable-automation'],
                });
            }
            catch (_) {
                this.browser = await playwright_1.chromium.launch({
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
                if (currentUrl.includes('vinted.') &&
                    !currentUrl.includes('/member/login') &&
                    !currentUrl.includes('/member/general/login') &&
                    !currentUrl.includes('/auth') &&
                    !currentUrl.includes('/login')) {
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
        }
        catch (err) {
            await this.close().catch(() => null);
            return { success: false, message: err.message || 'Помилка відкриття браузера' };
        }
    }
    async close() {
        try {
            if (this.context && !this.hasRateLimit) {
                await this.context.storageState({ path: COOKIES_PATH });
            }
        }
        catch (_) {
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
    clearCookies() {
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
            }
            catch (err) {
                console.warn('[VintedBrowser] Error deleting %s:', p, err);
            }
        }
        return deleted;
    }
    async acceptCookies(page) {
        try {
            const cookieBtn = await page.waitForSelector('#onetrust-accept-btn-handler, button[id*="accept"], button:has-text("Aceptar todas"), button:has-text("Aceptar")', { timeout: 4000 });
            if (cookieBtn) {
                await cookieBtn.click();
                await page.waitForTimeout(500);
            }
        }
        catch (_) {
            // Cookies dialog might not appear
        }
    }
    async isLoggedIn() {
        if (!this.page)
            return false;
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
            const uploadArea = await this.page.$('input[data-testid="add-photos-input"], input[type="file"], input[data-testid="title--input"], input[name="title"]');
            return Boolean(uploadArea);
        }
        catch (err) {
            console.warn('[VintedBrowser] isLoggedIn check failed:', err);
            return false;
        }
    }
    async login(email, password) {
        if (!this.page)
            return false;
        try {
            console.log('[VintedBrowser] Navigating to login page...');
            await this.page.goto('https://www.vinted.com/member/login/email', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.acceptCookies(this.page);
            await this.page.waitForTimeout(1500);
            if (!email || !password) {
                return false;
            }
            // Vinted often has email/password fields or a button "Continuar con el email"
            const emailLoginBtn = await this.page.$('button:has-text("email"), a:has-text("email"), [data-testid="auth-select-type--email"]');
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
        }
        catch (err) {
            console.warn('[VintedBrowser] Automatic login failed (likely captcha or antibot):', err);
            return false;
        }
    }
    // ─── Publish Flow ───────────────────────────────────────────────────────────
    async publishProduct(product) {
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
                    header.style.pointerEvents = 'none';
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
            let images = [];
            try {
                images = JSON.parse(product.images || '[]');
            }
            catch {
                images = [];
            }
            // Если фоток меньше 3 — публикуем все, если 3 и больше — пропускаем первые две
            const vintedImages = images.length < 3 ? images : images.slice(2);
            if (vintedImages.length > 0) {
                const absoluteImagePaths = vintedImages.map(uploads_1.resolveUploadedPhoto).filter((p) => p !== null);
                if (absoluteImagePaths.length > 0) {
                    console.log('[VintedPublish] Uploading %d photos (%s): %j', absoluteImagePaths.length, images.length < 3 ? 'all photos (less than 3)' : 'skipped first 2', absoluteImagePaths);
                    let fileInput = await this.page.$('input[data-testid="add-photos-input"], input[name="photos"], input[type="file"][accept*="image"]');
                    if (!fileInput) {
                        fileInput = await this.page.waitForSelector('input[data-testid="add-photos-input"], input[name="photos"], input[type="file"][accept*="image"]', { state: 'attached', timeout: 25000 }).catch(async () => {
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
            const titleInput = await this.page.waitForSelector('input[data-testid="title--input"], #title, input[name="title"]', { timeout: 10000 });
            if (titleInput) {
                await titleInput.click();
                await titleInput.fill(titleToUse);
                await this.randomDelay(300, 600);
            }
            // 3. Description: Use specific vintedDescription if provided, else fallback
            const descToUse = (product.vintedDescription || product.description).trim();
            const descInput = await this.page.waitForSelector('textarea[data-testid="description--input"], #description, textarea[name="description"]', { timeout: 10000 });
            if (descInput) {
                await descInput.click();
                await descInput.fill(descToUse);
                await this.randomDelay(300, 600);
            }
            // 4. Category
            await this.selectCategory(product.vintedCategory || product.category, product.subcategory);
            // 5. Brand (Marca)
            await this.selectBrand(product.brand);
            await this.dismissAuthenticityModal();
            // 6. Size (Talla)
            await this.selectSize(product.vintedSize);
            // 7. Condition (Estado) - Всегда берем второй пункт
            await this.selectCondition(product.condition);
            // 8. Color (Color)
            await this.selectColor(product.color);
            // 9. Material (Material)
            await this.selectMaterial(product.material);
            // 10. Fill any other dynamic dropdowns/fields Vinted might render for this category
            await this.fillRemainingDynamicFields();
            // 11. Price: Use vintedPrice if provided, else standard price
            const priceToUse = product.vintedPrice ?? product.price;
            const priceInput = await this.page.waitForSelector('input[data-testid="price-input--input"], #price, input[name="price"]', { timeout: 10000 });
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
            const submitBtn = await this.page.$('button[data-testid="upload-form-save-button"], button[type="button"]:has-text("Subir"), button[type="submit"]:has-text("Subir")');
            if (submitBtn) {
                console.log('[VintedPublish] Clicking submit button...');
                await this.dismissAuthenticityModal();
                const critCheck = await this.page.$('[data-testid*="critical-error"], [data-testid="item-upload-critical-error-dialog"]');
                if (critCheck && await critCheck.isVisible().catch(() => false)) {
                    const dialogText = await critCheck.innerText().catch(() => '');
                    const cleanMsg = dialogText.replace(/\s+/g, ' ').trim();
                    return { success: false, error: `Vinted показав критичну помилку форми: ${cleanMsg || 'item-upload-critical-error-dialog'}` };
                }
                await submitBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await this.page.waitForTimeout(500);
                await this.dismissAuthenticityModal();
                await submitBtn.click();
                // Wait for redirect to item page or profile
                await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
                await this.page.waitForTimeout(3000);
                const currentUrl = this.page.url();
                console.log('[VintedPublish] Post-submit URL: %s', currentUrl);
                if (currentUrl.includes('/member/') || (currentUrl.includes('/items/') && !currentUrl.includes('/items/new'))) {
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
                if (retryUrl.includes('/member/') || (retryUrl.includes('/items/') && !retryUrl.includes('/items/new'))) {
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
                    const validationErrors = await this.page.$$eval('[data-bloom="true"] [role="alert"], [class*="error"], [class*="helper-error"]', (elements) => elements.map((e) => e.textContent?.trim()).filter(Boolean)).catch(() => []);
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
            }
            else {
                return { success: false, error: 'Кнопку відправки "Subir" не знайдено на сторінці Vinted' };
            }
        }
        catch (err) {
            console.error('[VintedPublish] Error publishing to Vinted:', err);
            // Capture debug screenshot
            try {
                const screenshotPath = path.resolve(`./debug-screenshots/vinted-error-${product.id}.png`);
                fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
                await this.page?.screenshot({ path: screenshotPath, fullPage: true });
                console.log('[VintedPublish] Saved error screenshot to %s', screenshotPath);
            }
            catch (_) { }
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
            }
            catch (_) { }
            return { success: false, error: err.message || 'Невідома помилка публікації на Vinted' };
        }
    }
    // ─── Field Helpers ──────────────────────────────────────────────────────────
    async selectCategory(categoryName, subcategoryName) {
        if (!this.page)
            return;
        try {
            const categoryTrigger = await this.page.$('button[data-testid="catalog-select-dropdown-input"], button[data-testid*="catalog"], #category, input[name="category"], [data-testid*="catalog-select-dropdown"]');
            if (!categoryTrigger)
                return;
            // 0. Проверяем: возможно категория уже выбрана на странице
            const initialText = await categoryTrigger.innerText().catch(() => '');
            if (initialText && !initialText.includes('Elige') && !initialText.includes('subcategoría')) {
                console.log('[VintedPublish] Category already selected: "%s"', initialText.trim());
                return;
            }
            // 1. Проверяем, появились ли готовые рекомендации категорий (chips) на основе названия и фото (ждем до 2с)
            await this.page.waitForTimeout(800);
            let suggestionChips = await this.page.$$('button[data-testid*="catalog-suggestion"], button[data-testid*="category-suggestion"], [data-testid*="suggestion"] button');
            if (suggestionChips.length === 0) {
                await this.page.waitForTimeout(1000);
                suggestionChips = await this.page.$$('button[data-testid*="catalog-suggestion"], button[data-testid*="category-suggestion"], [data-testid*="suggestion"] button');
            }
            if (suggestionChips.length > 0) {
                console.log('[VintedPublish] Found %d category suggestion chips', suggestionChips.length);
                // Проверяем, может одна из подсказок уже активна (чекнута)
                let activeChip = null;
                for (const chip of suggestionChips) {
                    const isAct = await chip.evaluate((node) => {
                        return (node.getAttribute('aria-pressed') === 'true' ||
                            node.getAttribute('aria-checked') === 'true' ||
                            node.getAttribute('aria-selected') === 'true' ||
                            node.classList.contains('is-selected') ||
                            node.classList.contains('active'));
                    }).catch(() => false);
                    if (isAct) {
                        activeChip = chip;
                        break;
                    }
                }
                if (activeChip) {
                    console.log('[VintedPublish] A category suggestion chip is ALREADY selected. Keeping it.');
                    return;
                }
                // Если не выбрана — ищем совпадение с указанной пользователем категорией, или берем первую
                const userCatLow = (subcategoryName || categoryName || '').toLowerCase().trim();
                let targetChip = suggestionChips[0];
                if (userCatLow) {
                    for (const chip of suggestionChips) {
                        const chipTxt = (await chip.innerText().catch(() => '')).toLowerCase();
                        if (chipTxt.includes(userCatLow)) {
                            targetChip = chip;
                            break;
                        }
                    }
                }
                const chipLabel = (await targetChip.innerText().catch(() => '')).trim();
                console.log('[VintedPublish] Clicking suggested category chip: "%s"', chipLabel);
                await targetChip.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await targetChip.click();
                await this.page.waitForTimeout(1000);
                const checkTrigger = await this.page.$('button[data-testid="catalog-select-dropdown-input"], #category, [data-testid*="catalog-select"]');
                const txt = checkTrigger ? (await checkTrigger.innerText().catch(() => '')) : '';
                if (txt && !txt.includes('Elige') && !txt.includes('subcategoría')) {
                    console.log('[VintedPublish] Category successfully set via suggestion chip: "%s"', txt.trim());
                    return;
                }
            }
            // 2. Открываем селектор категории
            await categoryTrigger.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
            await categoryTrigger.click();
            await this.page.waitForTimeout(800);
            const containerSelector = '[data-radix-popper-content-wrapper], [data-testid="catalog-select-dropdown-content"], [data-testid*="catalog-select"], div[role="dialog"]';
            // 2a. Проверяем: если внутри селектора категория уже выбрана (стоит чекбокс/радио) — не сбрасываем!
            const alreadyCheckedOption = await this.page.$(`${containerSelector} [role="radio"][aria-checked="true"], ` +
                `${containerSelector} [role="checkbox"][aria-checked="true"], ` +
                `${containerSelector} input:checked`);
            if (alreadyCheckedOption) {
                console.log('[VintedPublish] Category option in dropdown is ALREADY checked. Keeping it.');
                await this.page.keyboard.press('Escape').catch(() => null);
                return;
            }
            // 2b. Проверяем: есть ли в выпадающем списке автоматические предложения от Vinted
            const suggestedInDropdown = await this.page.$$(`${containerSelector} [data-testid*="suggestion"] [role="radio"], ` +
                `${containerSelector} [data-testid*="recommended"] [role="radio"], ` +
                `${containerSelector} [data-testid*="suggested"] [role="radio"]`);
            if (suggestedInDropdown.length > 0) {
                const firstSug = suggestedInDropdown[0];
                const label = (await firstSug.innerText().catch(() => '')).trim();
                console.log('[VintedPublish] Found auto-suggested category in dropdown: "%s". Checking it...', label);
                await this.safeCheckOption(firstSug, label);
                await this.page.waitForTimeout(800);
                await this.page.keyboard.press('Escape').catch(() => null);
                return;
            }
            // 3. Этап: если категории нет, ищем строку поиска и вводим ту, что указал пользователь
            const targetQuery = (categoryName || subcategoryName || '').trim();
            const searchInput = await this.page.$(`${containerSelector} input[type="search"], ${containerSelector} input[placeholder*="buscar" i], ${containerSelector} input[placeholder*="categor" i], ${containerSelector} input[type="text"]`);
            if (searchInput && targetQuery) {
                console.log('[VintedPublish] Searching user category: "%s"', targetQuery);
                await searchInput.fill(targetQuery);
                await this.page.waitForTimeout(800);
                const searchResults = await this.page.$$(`${containerSelector} div[role="radio"], ${containerSelector} button[role="radio"], ${containerSelector} [role="menuitemradio"], ${containerSelector} div[role="checkbox"], ${containerSelector} div[class*="option"]`);
                if (searchResults.length > 0) {
                    let matched = null;
                    const queryLow = targetQuery.toLowerCase();
                    for (const opt of searchResults) {
                        const optText = (await opt.innerText().catch(() => '')).toLowerCase();
                        if (optText.includes(queryLow)) {
                            matched = opt;
                            break;
                        }
                    }
                    if (!matched) {
                        matched = searchResults[0];
                    }
                    const matchedLabel = (await matched.innerText().catch(() => '')).trim();
                    console.log('[VintedPublish] Selected category search result: "%s"', matchedLabel);
                    await this.safeCheckOption(matched, matchedLabel);
                    await this.page.waitForTimeout(800);
                    await this.page.keyboard.press('Escape').catch(() => null);
                    return;
                }
            }
            // 4. Запасной спуск вглубь дерева категорий до конечной подкатегории (до 7 уровней)
            for (let step = 0; step < 7; step++) {
                // Проверяем радио-кнопки (конечный уровень подкатегории)
                const radioOptions = await this.page.$$(`${containerSelector} div[role="radio"], ${containerSelector} button[role="radio"], ${containerSelector} [role="menuitemradio"], ${containerSelector} input[type="radio"]`);
                if (radioOptions.length > 0) {
                    let chosen = radioOptions[0];
                    const search = (subcategoryName || categoryName || '').toLowerCase().trim();
                    let matched = false;
                    if (search) {
                        for (const r of radioOptions) {
                            const text = (await r.innerText()).toLowerCase();
                            if (text.includes(search)) {
                                chosen = r;
                                matched = true;
                                break;
                            }
                        }
                    }
                    if (!matched) {
                        for (const r of radioOptions) {
                            const text = (await r.innerText()).toLowerCase();
                            if (text.includes('otro') || text.includes('otra') || text.includes('general')) {
                                chosen = r;
                                matched = true;
                                break;
                            }
                        }
                    }
                    const chosenLabel = (await chosen.innerText()).trim();
                    console.log('[VintedPublish] Selecting leaf subcategory: "%s"', chosenLabel);
                    await this.safeCheckOption(chosen, chosenLabel);
                    await this.page.waitForTimeout(1000);
                    return;
                }
                // Промежуточные уровни (кнопки с шевронами)
                const buttons = await this.page.$$(`${containerSelector} div[role="button"], ${containerSelector} button[role="menuitem"], ${containerSelector} [role="menuitem"], ${containerSelector} button`);
                if (buttons.length === 0)
                    break;
                const validBranches = [];
                for (const b of buttons) {
                    const text = (await b.innerText()).toLowerCase().trim();
                    if (!text || text === 'atrás' || text === 'volver' || text === 'back' || text.startsWith('atras')) {
                        continue;
                    }
                    validBranches.push({ el: b, text });
                }
                if (validBranches.length === 0)
                    break;
                let targetBtn = validBranches[0].el;
                let targetText = validBranches[0].text;
                if (step === 0) {
                    const catLow = (categoryName || '').toLowerCase();
                    let preferredRoot = 'hogar';
                    if (catLow.match(/hogar|casa|cocina|mueble|bricolaje|jard[íi]n|herramienta|v[áa]lvula|electrov[áa]lvula|cafetera|l[áa]mpara|limpieza|ba[ñn]o|decoraci/)) {
                        preferredRoot = 'hogar';
                    }
                    else if (catLow.match(/electr[óo]nica|tecnolog[íi]a|m[óo]vil|consola|videojuego|ordenador|pc|audio|tele|c[áa]mara/)) {
                        preferredRoot = 'entretenimiento';
                    }
                    else if (catLow.match(/mascota|perro|gato|animal/)) {
                        preferredRoot = 'mascotas';
                    }
                    else if (catLow.match(/hombre|chico|caballero/)) {
                        preferredRoot = 'hombres';
                    }
                    else if (catLow.match(/ni[ñn]o|beb[ée]|juguete/)) {
                        preferredRoot = 'niños';
                    }
                    for (const vb of validBranches) {
                        if (vb.text.includes(preferredRoot)) {
                            targetBtn = vb.el;
                            targetText = vb.text;
                            break;
                        }
                    }
                }
                else {
                    const subLow = (subcategoryName || categoryName || '').toLowerCase().trim();
                    let found = false;
                    if (subLow) {
                        for (const vb of validBranches) {
                            if (vb.text.includes(subLow)) {
                                targetBtn = vb.el;
                                targetText = vb.text;
                                found = true;
                                break;
                            }
                        }
                    }
                    if (!found) {
                        for (const vb of validBranches) {
                            if (vb.text.includes('otro') || vb.text.includes('otra') || vb.text.includes('general')) {
                                targetBtn = vb.el;
                                targetText = vb.text;
                                found = true;
                                break;
                            }
                        }
                    }
                }
                console.log('[VintedPublish] Category step %d: navigating into "%s"', step, targetText);
                await targetBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await targetBtn.click();
                await this.page.waitForTimeout(800);
            }
            // 5. Проверяем, не осталось ли "Elige una subcategoría"
            const afterText = await categoryTrigger.innerText().catch(() => '');
            if (afterText.includes('Elige') || afterText.includes('subcategoría')) {
                console.warn('[VintedPublish] Subcategory still not selected ("%s"), selecting any leaf option...', afterText.trim());
                const anyRadio = await this.page.$(`${containerSelector} div[role="radio"], ${containerSelector} button[role="radio"], ${containerSelector} input[type="radio"]`);
                if (anyRadio) {
                    const label = (await anyRadio.innerText().catch(() => '')).trim();
                    await this.safeCheckOption(anyRadio, label);
                    await this.page.waitForTimeout(800);
                }
            }
            await this.page.keyboard.press('Escape').catch(() => null);
            await this.page.waitForTimeout(400);
        }
        catch (e) {
            console.warn('[VintedPublish] Category selection skipped or failed:', e);
            await this.page?.keyboard.press('Escape').catch(() => null);
        }
    }
    async selectBrand(brand) {
        if (!this.page)
            return;
        try {
            const brandBtn = await this.page.$('button[data-testid="brand-select-dropdown-input"], #brand, [data-testid="brand-select-dropdown-input"]');
            if (brandBtn) {
                await brandBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await brandBtn.click();
                await this.page.waitForTimeout(600);
                let selected = false;
                const brandQuery = (brand || '').trim();
                const searchInput = await this.page.$('[data-radix-popper-content-wrapper] input[type="search"], [data-radix-popper-content-wrapper] input[type="text"], input[placeholder*="buscar" i]');
                if (brandQuery && searchInput) {
                    await searchInput.fill(brandQuery);
                    await this.page.waitForTimeout(600);
                    const matchItem = await this.page.$(`[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("${brandQuery}"), [data-radix-popper-content-wrapper] button:has-text("${brandQuery}"), [data-radix-popper-content-wrapper] div[role="radio"]:has-text("${brandQuery}")`);
                    if (matchItem) {
                        await matchItem.click();
                        selected = true;
                        console.log('[VintedPublish] Brand selected: "%s"', brandQuery);
                    }
                }
                // Если бренда нет в списке или не нашли — выбираем "Publicar sin marca" / "Sin marca"
                if (!selected) {
                    console.log('[VintedPublish] Brand "%s" not found, looking for "Publicar sin marca"...', brandQuery);
                    // 1. Сначала проверяем, есть ли уже кнопка/опция "Publicar sin marca" прямо на экране
                    let sinMarcaBtn = await this.page.$('[data-radix-popper-content-wrapper] button:has-text("Publicar sin marca"), ' +
                        '[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("Publicar sin marca"), ' +
                        '[data-radix-popper-content-wrapper] div[role="radio"]:has-text("Publicar sin marca"), ' +
                        '[data-radix-popper-content-wrapper] div:has-text("Publicar sin marca"), ' +
                        'button:has-text("Publicar sin marca"), ' +
                        'div[role="menuitem"]:has-text("Publicar sin marca"), ' +
                        'span:has-text("Publicar sin marca"), ' +
                        'a:has-text("Publicar sin marca")');
                    // 2. Если сразу нет — очищаем поиск или вводим "Sin marca"
                    if (!sinMarcaBtn && searchInput) {
                        await searchInput.fill('');
                        await searchInput.fill('Sin marca');
                        await this.page.waitForTimeout(600);
                        sinMarcaBtn = await this.page.$('[data-radix-popper-content-wrapper] button:has-text("Publicar sin marca"), ' +
                            '[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("Publicar sin marca"), ' +
                            '[data-radix-popper-content-wrapper] div[role="radio"]:has-text("Publicar sin marca"), ' +
                            '[data-radix-popper-content-wrapper] div:has-text("Publicar sin marca"), ' +
                            'button:has-text("Publicar sin marca"), ' +
                            'div[role="menuitem"]:has-text("Publicar sin marca"), ' +
                            'span:has-text("Publicar sin marca"), ' +
                            'a:has-text("Publicar sin marca"), ' +
                            '[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("Sin marca"), ' +
                            '[data-radix-popper-content-wrapper] button:has-text("Sin marca"), ' +
                            '[data-radix-popper-content-wrapper] div[role="radio"]:has-text("Sin marca"), ' +
                            '[data-radix-popper-content-wrapper] [role="option"]:has-text("Sin marca"), ' +
                            '[data-radix-popper-content-wrapper] span:has-text("Sin marca")');
                    }
                    if (sinMarcaBtn) {
                        await sinMarcaBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                        await sinMarcaBtn.click();
                        selected = true;
                        console.log('[VintedPublish] Clicked "Publicar sin marca" / "Sin marca"');
                    }
                    else {
                        // Запасные варианты на других языках
                        const fallbackOption = await this.page.$(`[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("No brand"), ` +
                            `[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("Unbranded"), ` +
                            `[data-radix-popper-content-wrapper] div[role="menuitem"]:has-text("Sans marque")`);
                        if (fallbackOption) {
                            await fallbackOption.click();
                            selected = true;
                            console.log('[VintedPublish] Selected fallback unbranded option');
                        }
                        else if (searchInput) {
                            // Если ввели в поиск, проверяем первый элемент в результатах
                            const firstResult = await this.page.$('[data-radix-popper-content-wrapper] div[role="menuitem"], [data-radix-popper-content-wrapper] button, [data-radix-popper-content-wrapper] div[role="radio"]');
                            if (firstResult) {
                                const text = (await firstResult.innerText()).toLowerCase();
                                if (text.includes('marca') || text.includes('brand')) {
                                    await firstResult.click();
                                    selected = true;
                                    console.log('[VintedPublish] Selected search result for unbranded: "%s"', text.trim());
                                }
                            }
                        }
                    }
                    // Если так и не удалось найти "Publicar sin marca", закрываем выпадающий список (Esc), не выбирая случайный бренд
                    if (!selected) {
                        console.warn('[VintedPublish] Neither "Publicar sin marca" nor "Sin marca" found, closing brand dropdown');
                        await this.page.keyboard.press('Escape').catch(() => null);
                    }
                }
                await this.page.waitForTimeout(500);
                await this.dismissAuthenticityModal();
            }
        }
        catch (e) {
            console.warn('[VintedPublish] Brand selection failed:', e);
        }
    }
    async dismissAuthenticityModal() {
        if (!this.page)
            return;
        try {
            await this.page.waitForTimeout(500);
            const modal = await this.page.$('[data-testid="authenticity-modal"], [data-testid="authenticity-modal--overlay"], div[class*="Dialog__portal"]:has-text("imitación"), div[class*="Dialog__modal"]:has-text("imitación")');
            if (modal) {
                console.log('[VintedPublish] Authenticity modal detected, attempting to dismiss...');
                const confirmBtn = await this.page.$('div[class*="Dialog__portal"] button:has-text("Entendido"), ' +
                    'div[class*="Dialog__portal"] button:has-text("Aceptar"), ' +
                    'div[class*="Dialog__portal"] button:has-text("Continuar"), ' +
                    'div[class*="Dialog__portal"] button:has-text("Lo he entendido"), ' +
                    'div[class*="Dialog__portal"] button:has-text("De acuerdo"), ' +
                    '[data-testid="authenticity-modal"] button, ' +
                    '[data-testid="authenticity-modal--overlay"] button, ' +
                    'div[class*="Dialog__portal"] button[data-testid*="confirm"], ' +
                    'div[class*="Dialog__portal"] [data-testid="modal-close"]');
                if (confirmBtn) {
                    await confirmBtn.click().catch(() => null);
                    console.log('[VintedPublish] Clicked confirmation on Authenticity modal');
                }
                else {
                    const anyBtn = await this.page.$('div[class*="Dialog__portal"] button');
                    if (anyBtn) {
                        await anyBtn.click().catch(() => null);
                    }
                    else {
                        await this.page.keyboard.press('Escape').catch(() => null);
                    }
                }
                await this.page.waitForTimeout(1000);
            }
        }
        catch (e) {
            console.warn('[VintedPublish] Error dismissing authenticity modal:', e);
        }
    }
    async selectCondition(_wallapopCondition) {
        if (!this.page)
            return;
        try {
            // Требование: состояние всегда брать второй пункт
            const condBtn = await this.page.$('button[data-testid="category-condition-single-list-input"], #condition');
            if (condBtn) {
                await condBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await condBtn.click();
                await this.page.waitForTimeout(600);
                // В выпадающем меню состояния опции имеют div[role="radio"] внутри popover:
                // 1-й пункт: Nuevo con etiquetas
                // 2-й пункт: Nuevo sin etiquetas (или En muy buen estado)
                const radioItems = await this.page.$$('[data-radix-popper-content-wrapper] div[role="radio"]');
                if (radioItems.length >= 2) {
                    console.log('[VintedPublish] Selecting 2nd condition option: %s', await radioItems[1].innerText().catch(() => 'item 2'));
                    await radioItems[1].click();
                }
                else if (radioItems.length === 1) {
                    await radioItems[0].click();
                }
                await this.page.waitForTimeout(500);
            }
        }
        catch (e) {
            console.warn('[VintedPublish] Condition selection failed:', e);
        }
    }
    async isElementChecked(el) {
        if (!el)
            return false;
        try {
            return await el.evaluate((node) => {
                if (!node)
                    return false;
                // 1. Прямой input checkbox / radio
                if (node instanceof HTMLInputElement) {
                    return node.checked;
                }
                // 2. Атрибут aria-checked="true"
                if (node.getAttribute('aria-checked') === 'true') {
                    return true;
                }
                // 3. Дочерний input checkbox / radio с флагом checked
                const childInput = node.querySelector ? node.querySelector('input[type="checkbox"], input[type="radio"]') : null;
                if (childInput && childInput.checked) {
                    return true;
                }
                // 4. Наличие атрибута checked
                if (node.hasAttribute('checked') && node.getAttribute('checked') !== 'false') {
                    return true;
                }
                // 5. CSS классы активного/выбранного чекбокса
                const className = (node.className || '').toString();
                if (/(?:^|\s|-|_)(checked|selected|active)(?:$|\s|-|_)/i.test(className) && !className.includes('not-checked')) {
                    const role = node.getAttribute('role');
                    if (role === 'checkbox' || role === 'radio' || role === 'menuitemcheckbox') {
                        return true;
                    }
                }
                return false;
            });
        }
        catch {
            return false;
        }
    }
    async safeCheckOption(el, description = 'option') {
        if (!el)
            return false;
        try {
            const alreadyChecked = await this.isElementChecked(el);
            if (alreadyChecked) {
                console.log(`[VintedPublish] Option "${description}" is ALREADY checked. Keeping it (no click).`);
                return true;
            }
            await el.evaluate((node) => node.scrollIntoView({ block: 'center' })).catch(() => null);
            await el.click();
            console.log(`[VintedPublish] Clicked to check option "${description}".`);
            return true;
        }
        catch (e) {
            console.warn(`[VintedPublish] Failed to check option "${description}":`, e);
            return false;
        }
    }
    async selectSize(size) {
        if (!this.page)
            return;
        try {
            const sizeBtn = await this.page.$('button[data-testid="category-size-single-grid-input"], ' +
                'button[data-testid="category-size-single-list-input"], ' +
                'button[data-testid*="size-single"], ' +
                'button[data-testid*="category-size"], ' +
                '#size, ' +
                '[data-testid="category-size-single-grid-input"], ' +
                '[data-testid="category-size-single-list-input"], ' +
                'button:has-text("Talla"), ' +
                'button:has-text("Elige la talla"), ' +
                'button:has-text("Medidas")');
            if (sizeBtn) {
                await sizeBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await sizeBtn.click();
                await this.page.waitForTimeout(600);
                // Если вылезла отдельная информационная подсказка / модалка о таблице размеров с кнопкой закрытия/подтверждения
                const infoModalClose = await this.page.$('div[class*="Dialog__modal"]:has-text("Tabla de tallas") button:has-text("Entendido"), ' +
                    'div[class*="Dialog__modal"]:has-text("Tabla de tallas") button:has-text("Aceptar"), ' +
                    'div[class*="Dialog__modal"]:has-text("Tabla de tallas") button:has-text("De acuerdo"), ' +
                    'div[class*="Dialog__modal"]:has-text("Tabla de tallas") [data-testid="modal-close"]');
                if (infoModalClose) {
                    await infoModalClose.click().catch(() => null);
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
                let selected = false;
                const sizeQuery = (size || '').trim().toLowerCase();
                // 0. Проверяем: если на сайте УЖЕ проставлен нужный чекбокс и у пользователя нет особого требования к размеру — не трогаем!
                if (!sizeQuery) {
                    const alreadyCheckedSize = await this.page.$('div[class*="dropdown__content"] [role="checkbox"][aria-checked="true"], ' +
                        'div[class*="dropdown__content"] [role="radio"][aria-checked="true"], ' +
                        '[data-radix-popper-content-wrapper] [role="checkbox"][aria-checked="true"], ' +
                        '[data-radix-popper-content-wrapper] [role="radio"][aria-checked="true"], ' +
                        'div[role="checkbox"][aria-checked="true"]');
                    if (alreadyCheckedSize) {
                        const checkedText = ((await alreadyCheckedSize.getAttribute('aria-label').catch(() => '')) ||
                            (await alreadyCheckedSize.innerText().catch(() => ''))).trim();
                        console.log('[VintedPublish] Size is ALREADY checked on page ("%s"). Preserving it (not unchecking).', checkedText);
                        selected = true;
                    }
                }
                // 1. Если указан конкретный размер, ищем совпадение по aria-label или тексту
                if (sizeQuery && !selected) {
                    const directMatch = await this.page.$(`[role="checkbox"][aria-label*="${sizeQuery}" i], ` +
                        `div[role="radio"][aria-label*="${sizeQuery}" i], ` +
                        `[data-testid*="grid-option"][aria-label*="${sizeQuery}" i], ` +
                        `div[class*="dropdown__content"] [role="checkbox"]:has-text("${sizeQuery}"), ` +
                        `[data-radix-popper-content-wrapper] :has-text("${sizeQuery}")`);
                    if (directMatch) {
                        await this.safeCheckOption(directMatch, `size ${sizeQuery}`);
                        selected = true;
                        console.log('[VintedPublish] Size selected via direct match: "%s"', sizeQuery);
                    }
                }
                // 2. Если размер не указан или не найден — сначала проверяем прямой селектор "Otra" / "Otro"
                if (!selected) {
                    const otraDirect = await this.page.$('div[role="checkbox"][aria-label="Otra"], ' +
                        '[aria-label="Otra"], ' +
                        'div[role="checkbox"][aria-label="Otro"], ' +
                        '[aria-label="Otro"], ' +
                        '[data-testid*="grid-option"][aria-label="Otra"], ' +
                        '[data-testid*="grid-option"][aria-label="Otro"], ' +
                        'div[class*="dropdown__content"] [role="checkbox"]:has-text("Otra"), ' +
                        'div[class*="dropdown__content"] [role="checkbox"]:has-text("Otro")');
                    if (otraDirect) {
                        await this.safeCheckOption(otraDirect, 'Otra / Otro');
                        selected = true;
                        console.log('[VintedPublish] Selected "Otra" / "Otro" via direct aria-label');
                    }
                }
                // 3. Если еще не выбран — проходим по всем доступным опциям в контейнерах
                if (!selected) {
                    console.log('[VintedPublish] Size "%s" not found via direct selector, searching containers...', sizeQuery);
                    for (const cSel of containerSelectors) {
                        const options = await this.page.$$(`${cSel} div[role="checkbox"], ${cSel} [role="checkbox"], ${cSel} div[role="radio"], ${cSel} button[role="radio"], ${cSel} div[role="menuitem"], ${cSel} [role="option"], ${cSel} button`);
                        if (options.length === 0)
                            continue;
                        // Приоритетно "Otra" / "Otro"
                        for (const opt of options) {
                            const text = ((await opt.getAttribute('aria-label').catch(() => '')) ||
                                (await opt.innerText().catch(() => ''))).toLowerCase().trim();
                            if (/\botra(s)?\b/i.test(text) || /\botro(s)?\b/i.test(text)) {
                                await this.safeCheckOption(opt, text);
                                selected = true;
                                console.log('[VintedPublish] Selected size option from container: "%s"', text);
                                break;
                            }
                        }
                        if (selected)
                            break;
                        // Затем "Talla única" / "Única" / "Sin talla" / "Universal"
                        for (const opt of options) {
                            const text = ((await opt.getAttribute('aria-label').catch(() => '')) ||
                                (await opt.innerText().catch(() => ''))).toLowerCase().trim();
                            if (text.includes('única') || text.includes('unica') || text.includes('sin talla') || text.includes('universal')) {
                                await this.safeCheckOption(opt, text);
                                selected = true;
                                console.log('[VintedPublish] Selected size fallback option: "%s"', text);
                                break;
                            }
                        }
                        if (selected)
                            break;
                        // Если ничего из вышеперечисленного нет, выбираем первый интерактивный пункт размера (пропуская заголовки и подсказки)
                        for (const opt of options) {
                            const text = ((await opt.getAttribute('aria-label').catch(() => '')) ||
                                (await opt.innerText().catch(() => ''))).toLowerCase().trim();
                            if (!text ||
                                text.includes('tabla de tallas') ||
                                text.includes('siguientes tallas') ||
                                text.includes('mide el largo') ||
                                text.includes('elige la talla') ||
                                text.includes('guía de tallas') ||
                                text.includes('atrás') ||
                                text.includes('volver')) {
                                continue;
                            }
                            await this.safeCheckOption(opt, text);
                            selected = true;
                            console.log('[VintedPublish] Selected first available size option: "%s"', text);
                            break;
                        }
                        if (selected)
                            break;
                    }
                }
                // Если внизу диалога есть кнопка подтверждения ("Aceptar" / "Guardar" / "Aplicar")
                const confirmBtn = await this.page.$('div[class*="Dialog__modal"] button:has-text("Aceptar"), ' +
                    'div[class*="Dialog__modal"] button:has-text("Guardar"), ' +
                    'div[class*="Dialog__modal"] button:has-text("Aplicar"), ' +
                    'div[role="dialog"] button:has-text("Aceptar"), ' +
                    'div[role="dialog"] button:has-text("Guardar")');
                if (confirmBtn) {
                    await confirmBtn.click().catch(() => null);
                }
                await this.page.waitForTimeout(500);
                await this.page.keyboard.press('Escape').catch(() => null);
            }
        }
        catch (e) {
            console.warn('[VintedPublish] Size selection failed:', e);
        }
    }
    async selectColor(color) {
        if (!this.page)
            return;
        try {
            const colorBtn = await this.page.$('button[data-testid="color-select-dropdown-input"], #color, [data-testid="color-select-dropdown-input"]');
            if (colorBtn) {
                await colorBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await colorBtn.click();
                await this.page.waitForTimeout(600);
                let selected = false;
                const colorQuery = (color || '').trim().toLowerCase();
                // 0. Проверяем: если Vinted уже сам выбрал цвет (чекбокс стоит)
                const alreadyCheckedColor = await this.page.$('[data-radix-popper-content-wrapper] [role="checkbox"][aria-checked="true"], ' +
                    '[data-radix-popper-content-wrapper] input[type="checkbox"]:checked, ' +
                    '[data-radix-popper-content-wrapper] [aria-checked="true"]');
                if (alreadyCheckedColor && !colorQuery) {
                    const checkedText = ((await alreadyCheckedColor.getAttribute('aria-label').catch(() => '')) ||
                        (await alreadyCheckedColor.innerText().catch(() => ''))).trim();
                    console.log('[VintedPublish] Color is ALREADY checked by Vinted ("%s"). Preserving it (not unchecking).', checkedText);
                    selected = true;
                }
                if (colorQuery && !selected) {
                    const colorOption = await this.page.$(`[data-radix-popper-content-wrapper] [role="checkbox"]:has-text("${colorQuery}"), [data-radix-popper-content-wrapper] button:has-text("${colorQuery}")`);
                    if (colorOption) {
                        await this.safeCheckOption(colorOption, colorQuery);
                        selected = true;
                    }
                }
                // Если цвет не задан и никакой цвет еще не выбран — берем первый
                if (!selected && !alreadyCheckedColor) {
                    const firstOption = await this.page.$('[data-radix-popper-content-wrapper] [role="checkbox"], [data-radix-popper-content-wrapper] div[role="radio"], [data-radix-popper-content-wrapper] button');
                    if (firstOption) {
                        await this.safeCheckOption(firstOption, 'first color');
                    }
                }
                await this.page.waitForTimeout(500);
                await this.page.keyboard.press('Escape').catch(() => null);
            }
        }
        catch (e) {
            console.warn('[VintedPublish] Color selection failed:', e);
        }
    }
    async selectMaterial(material) {
        if (!this.page)
            return;
        try {
            const matBtn = await this.page.$('button[data-testid="category-material-multi-list-input"], #material, [data-testid="category-material-multi-list-input"]');
            if (matBtn) {
                await matBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await matBtn.click();
                await this.page.waitForTimeout(600);
                let selected = false;
                const matQuery = (material || '').trim().toLowerCase();
                // 0. Проверяем: если материал уже выбран на сайте (чекбокс стоит)
                const alreadyCheckedMat = await this.page.$('[data-radix-popper-content-wrapper] [role="checkbox"][aria-checked="true"], ' +
                    '[data-radix-popper-content-wrapper] input[type="checkbox"]:checked, ' +
                    '[data-radix-popper-content-wrapper] [aria-checked="true"]');
                if (alreadyCheckedMat && !matQuery) {
                    const checkedText = ((await alreadyCheckedMat.getAttribute('aria-label').catch(() => '')) ||
                        (await alreadyCheckedMat.innerText().catch(() => ''))).trim();
                    console.log('[VintedPublish] Material is ALREADY checked by Vinted ("%s"). Preserving it (not unchecking).', checkedText);
                    selected = true;
                }
                if (matQuery && !selected) {
                    const matOption = await this.page.$(`[data-radix-popper-content-wrapper] :has-text("${matQuery}")`);
                    if (matOption) {
                        await this.safeCheckOption(matOption, matQuery);
                        selected = true;
                    }
                }
                if (!selected && !alreadyCheckedMat) {
                    const firstOption = await this.page.$('[data-radix-popper-content-wrapper] [role="checkbox"], [data-radix-popper-content-wrapper] div[role="menuitem"], [data-radix-popper-content-wrapper] button');
                    if (firstOption) {
                        await this.safeCheckOption(firstOption, 'first material');
                    }
                }
                await this.page.waitForTimeout(500);
                await this.page.keyboard.press('Escape').catch(() => null);
            }
        }
        catch (e) {
            console.warn('[VintedPublish] Material selection failed:', e);
        }
    }
    async fillRemainingDynamicFields() {
        if (!this.page)
            return;
        try {
            // Находим все незаполненные селекторы/выпадающие списки в блоке Detalles del artículo
            const unselectedButtons = await this.page.$$('.select-wrapper button[aria-haspopup="menu"][data-placeholder=""]');
            for (const btn of unselectedButtons) {
                try {
                    const isCategory = await btn.getAttribute('data-testid');
                    if (isCategory === 'catalog-select-dropdown-input')
                        continue;
                    await btn.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                    await btn.click();
                    await this.page.waitForTimeout(600);
                    // Проверяем, не выбран ли уже какой-то чекбокс внутри
                    const alreadyChecked = await this.page.$('[data-radix-popper-content-wrapper] [role="checkbox"][aria-checked="true"], ' +
                        '[data-radix-popper-content-wrapper] [role="radio"][aria-checked="true"], ' +
                        '[data-radix-popper-content-wrapper] input:checked');
                    if (alreadyChecked) {
                        console.log('[VintedPublish] Dynamic field already has option checked, keeping it.');
                        await this.page.keyboard.press('Escape').catch(() => null);
                        continue;
                    }
                    // Берем первый доступный вариант в открывшемся поповере
                    const option = await this.page.$('[data-radix-popper-content-wrapper] div[role="menuitem"], [data-radix-popper-content-wrapper] [role="option"], [data-radix-popper-content-wrapper] [role="checkbox"], [data-radix-popper-content-wrapper] button, [data-radix-popper-content-wrapper] div[role="radio"]');
                    if (option) {
                        await this.safeCheckOption(option, 'dynamic field option');
                        await this.page.waitForTimeout(400);
                    }
                    else {
                        await this.page.keyboard.press('Escape').catch(() => null);
                    }
                }
                catch (_) { }
            }
        }
        catch (e) {
            console.warn('[VintedPublish] fillRemainingDynamicFields notice:', e);
        }
    }
    async handlePackageSize() {
        if (!this.page)
            return;
        try {
            // Требование: всегда выбирать рекомендованный / маленький размер (Pequeño / Recomendado)
            // 1. Проверяем вариант с бейджем Recomendado
            const recommendedCell = await this.page.$('div:has(span:has-text("Recomendado")) input[type="radio"], ' +
                'div:has-text("Recomendado") input[type="radio"], ' +
                '[data-testid*="package-size--cell"]:has-text("Recomendado"), ' +
                'label:has-text("Recomendado"), ' +
                'div[role="radio"]:has-text("Recomendado")');
            if (recommendedCell) {
                await recommendedCell.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await recommendedCell.click();
                console.log('[VintedPublish] Selected "Recomendado" package size');
                return;
            }
            // 2. Ищем размер "Pequeño"
            const smallCell = await this.page.$('[data-testid="1-package-size--cell"], [data-testid="1-package-size--cell--suffix"], ' +
                '#package-size-1, label[for="package_type_selector_1"], [data-testid="package_type_selector_1"], ' +
                'div[data-testid*="package-size"]:has-text("Pequeño"), ' +
                'div:has-text("Pequeño") input[type="radio"], ' +
                'label:has-text("Pequeño"), ' +
                'div[role="radio"]:has-text("Pequeño")');
            if (smallCell) {
                await smallCell.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => null);
                await smallCell.click();
                console.log('[VintedPublish] Selected "Pequeño" package size');
                return;
            }
            // 3. Если нет, берем первый радиобаттон размера (наименьший)
            const firstRadio = await this.page.$('input[name*="package_type_selector"], input[name*="package_size"]');
            if (firstRadio) {
                await firstRadio.click();
                console.log('[VintedPublish] Selected first available package size');
            }
        }
        catch (e) {
            console.warn('[VintedPublish] handlePackageSize failed:', e);
        }
    }
    sanitizeCookiesFile() {
        if (!fs.existsSync(COOKIES_PATH))
            return;
        try {
            const rawData = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
            const cookiesList = rawData.cookies || [];
            // Find authentic user token (scope: "user")
            const userToken = cookiesList.find((c) => c.name === 'access_token_web' &&
                c.value?.startsWith('ey') &&
                (() => {
                    try {
                        const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
                        return p.scope === 'user';
                    }
                    catch {
                        return false;
                    }
                })());
            const vUidCookie = cookiesList.find((c) => c.name === 'v_uid');
            const vSidCookie = cookiesList.find((c) => c.name === 'v_sid');
            const cleanedCookies = cookiesList.filter((c) => {
                if (c.name === 'access_token_web' && userToken) {
                    try {
                        const p = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64').toString());
                        if (p.scope === 'public')
                            return false;
                    }
                    catch { }
                }
                return true;
            });
            const domains = ['.vinted.es', 'www.vinted.es', '.vinted.com', 'www.vinted.com'];
            if (userToken) {
                for (const d of domains) {
                    cleanedCookies.push({ ...userToken, domain: d });
                    if (vUidCookie)
                        cleanedCookies.push({ ...vUidCookie, domain: d });
                    if (vSidCookie)
                        cleanedCookies.push({ ...vSidCookie, domain: d });
                }
            }
            rawData.cookies = cleanedCookies;
            fs.writeFileSync(COOKIES_PATH, JSON.stringify(rawData, null, 2), 'utf-8');
            console.log('[VintedBrowser] Sanitized cookies in %s', COOKIES_PATH);
        }
        catch (_) { }
    }
    async randomDelay(minMs, maxMs) {
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        if (this.page) {
            await this.page.waitForTimeout(delay);
        }
    }
}
exports.VintedBrowserService = VintedBrowserService;
exports.vintedBrowserService = new VintedBrowserService();
