import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../db/prisma';
import { browserService } from '../services/browser.service';
import { createError } from '../middleware/error';

const router = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  wallapopEmail: z.string().email().or(z.literal('')).optional(),
  wallapopPassword: z.string().optional(),
  publishDelay: z.number().int().min(0).max(3600).optional(),
  headless: z.boolean().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/settings
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getOrCreateSettings();
    res.json({
      ...settings,
      // Never expose the real password to the frontend
      wallapopPassword: settings.wallapopPassword ? '***' : '',
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(`Validation error: ${parsed.error.message}`, 400);
    }

    const data = parsed.data;

    // If password is '***', it means the frontend didn't change it — keep existing
    const updateData: Record<string, unknown> = {};
    if (data.wallapopEmail !== undefined) updateData.wallapopEmail = data.wallapopEmail;
    if (data.wallapopPassword !== undefined && data.wallapopPassword !== '***') {
      updateData.wallapopPassword = data.wallapopPassword;
    }
    if (data.publishDelay !== undefined) updateData.publishDelay = data.publishDelay;
    if (data.headless !== undefined) updateData.headless = data.headless;

    const current = await getOrCreateSettings();
    const settings = await prisma.settings.update({
      where: { id: current.id },
      data: updateData,
    });

    res.json({
      ...settings,
      wallapopPassword: settings.wallapopPassword ? '***' : '',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/test-login
router.post('/test-login', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getOrCreateSettings();

    if (!settings.wallapopEmail || !settings.wallapopPassword) {
      throw createError('Email and password must be configured before testing login', 400);
    }

    // Initialize browser in non-headless mode so user can see what's happening
    await browserService.initialize(false);

    let success = false;
    let message = '';

    try {
      // First check if already logged in via saved session
      success = await browserService.isLoggedIn();
      if (success) {
        message = 'Already logged in (session restored from cookies)';
      } else {
        success = await browserService.login(settings.wallapopEmail, settings.wallapopPassword);
        message = success ? 'Login successful' : 'Login failed. Check your credentials.';
      }
    } finally {
      // Close browser after test — queue will open its own instance when needed
      await browserService.close();
    }

    if (success) {
      res.json({ success: true, message });
    } else {
      res.status(401).json({ success: false, message });
    }
  } catch (err) {
    await browserService.close().catch(() => null);
    next(err);
  }
});

// POST /api/settings/import-cookies
router.post('/import-cookies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cookies } = req.body;
    if (!cookies || typeof cookies !== 'string') {
      throw createError('Вкажіть кукі для імпорту', 400);
    }
    const result = await browserService.importCookies(cookies);
    if (!result.success) {
      return res.status(400).json(result);
    }

    // Verify session
    await browserService.initialize(true);
    let sessionActive = false;
    try {
      sessionActive = await browserService.isLoggedIn();
    } finally {
      await browserService.close();
    }

    res.json({
      success: true,
      count: result.count,
      sessionActive,
      message: sessionActive
        ? `Успішно імпортовано ${result.count} кукі! Сесія активна.`
        : `Імпортовано ${result.count} кукі, але сесія ще не підтверджена. Перевірте, чи ви скопіювали актуальні кукі з авторизованого акаунту.`,
    });
  } catch (err) {
    await browserService.close().catch(() => null);
    next(err);
  }
});

// POST /api/settings/open-browser
router.post('/open-browser', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await browserService.openBrowserForManualLogin();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getOrCreateSettings() {
  const existing = await prisma.settings.findFirst();
  if (existing) return existing;
  return prisma.settings.create({
    data: {
      wallapopEmail: '',
      wallapopPassword: '',
      publishDelay: 30,
      headless: true,
    },
  });
}

export default router;
