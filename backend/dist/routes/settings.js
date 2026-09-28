"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../db/prisma"));
const browser_service_1 = require("../services/browser.service");
const error_1 = require("../middleware/error");
const router = (0, express_1.Router)();
// ─── Validation ───────────────────────────────────────────────────────────────
const settingsSchema = zod_1.z.object({
    wallapopEmail: zod_1.z.string().email().or(zod_1.z.literal('')).optional(),
    wallapopPassword: zod_1.z.string().optional(),
    publishDelay: zod_1.z.number().int().min(0).max(3600).optional(),
    headless: zod_1.z.boolean().optional(),
});
// ─── Routes ───────────────────────────────────────────────────────────────────
// GET /api/settings
router.get('/', async (_req, res, next) => {
    try {
        const settings = await getOrCreateSettings();
        res.json({
            ...settings,
            // Never expose the real password to the frontend
            wallapopPassword: settings.wallapopPassword ? '***' : '',
        });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/settings
router.put('/', async (req, res, next) => {
    try {
        const parsed = settingsSchema.safeParse(req.body);
        if (!parsed.success) {
            throw (0, error_1.createError)(`Validation error: ${parsed.error.message}`, 400);
        }
        const data = parsed.data;
        // If password is '***', it means the frontend didn't change it — keep existing
        const updateData = {};
        if (data.wallapopEmail !== undefined)
            updateData.wallapopEmail = data.wallapopEmail;
        if (data.wallapopPassword !== undefined && data.wallapopPassword !== '***') {
            updateData.wallapopPassword = data.wallapopPassword;
        }
        if (data.publishDelay !== undefined)
            updateData.publishDelay = data.publishDelay;
        if (data.headless !== undefined)
            updateData.headless = data.headless;
        const current = await getOrCreateSettings();
        const settings = await prisma_1.default.settings.update({
            where: { id: current.id },
            data: updateData,
        });
        res.json({
            ...settings,
            wallapopPassword: settings.wallapopPassword ? '***' : '',
        });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/settings/test-login
router.post('/test-login', async (_req, res, next) => {
    try {
        const settings = await getOrCreateSettings();
        if (!settings.wallapopEmail || !settings.wallapopPassword) {
            throw (0, error_1.createError)('Email and password must be configured before testing login', 400);
        }
        // Initialize browser in non-headless mode so user can see what's happening
        await browser_service_1.browserService.initialize(false);
        let success = false;
        let message = '';
        try {
            // First check if already logged in via saved session
            success = await browser_service_1.browserService.isLoggedIn();
            if (success) {
                message = 'Already logged in (session restored from cookies)';
            }
            else {
                success = await browser_service_1.browserService.login(settings.wallapopEmail, settings.wallapopPassword);
                message = success ? 'Login successful' : 'Login failed. Check your credentials.';
            }
        }
        finally {
            // Close browser after test — queue will open its own instance when needed
            await browser_service_1.browserService.close();
        }
        if (success) {
            res.json({ success: true, message });
        }
        else {
            res.status(401).json({ success: false, message });
        }
    }
    catch (err) {
        await browser_service_1.browserService.close().catch(() => null);
        next(err);
    }
});
// POST /api/settings/import-cookies
router.post('/import-cookies', async (req, res, next) => {
    try {
        const { cookies } = req.body;
        if (!cookies || typeof cookies !== 'string') {
            throw (0, error_1.createError)('Вкажіть кукі для імпорту', 400);
        }
        const result = await browser_service_1.browserService.importCookies(cookies);
        if (!result.success) {
            return res.status(400).json(result);
        }
        // Verify session
        await browser_service_1.browserService.initialize(true);
        let sessionActive = false;
        try {
            sessionActive = await browser_service_1.browserService.isLoggedIn();
        }
        finally {
            await browser_service_1.browserService.close();
        }
        res.json({
            success: true,
            count: result.count,
            sessionActive,
            message: sessionActive
                ? `Успішно імпортовано ${result.count} кукі! Сесія активна.`
                : `Імпортовано ${result.count} кукі, але сесія ще не підтверджена. Перевірте, чи ви скопіювали актуальні кукі з авторизованого акаунту.`,
        });
    }
    catch (err) {
        await browser_service_1.browserService.close().catch(() => null);
        next(err);
    }
});
// POST /api/settings/open-browser
router.post('/open-browser', async (_req, res, next) => {
    try {
        const result = await browser_service_1.browserService.openBrowserForManualLogin();
        res.json(result);
    }
    catch (err) {
        next(err);
    }
});
// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getOrCreateSettings() {
    const existing = await prisma_1.default.settings.findFirst();
    if (existing)
        return existing;
    return prisma_1.default.settings.create({
        data: {
            wallapopEmail: '',
            wallapopPassword: '',
            publishDelay: 30,
            headless: true,
        },
    });
}
exports.default = router;
