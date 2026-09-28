'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, AlertTriangle, Save, LogIn, ExternalLink, Key } from 'lucide-react';
import { getSettings, updateSettings, testLogin, importCookies, openBrowserForLogin, Settings } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import toast from 'react-hot-toast';

const schema = z.object({
  wallapopEmail: z.string().email('Введіть коректний email'),
  wallapopPassword: z.string().min(1, 'Вкажіть пароль'),
  publishDelay: z.coerce.number().int().min(5, 'Мінімум 5 секунд').max(3600, 'Максимум 3600 секунд'),
  headless: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingLogin, setTestingLogin] = useState(false);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [importingCookies, setImportingCookies] = useState(false);
  const [cookiesText, setCookiesText] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      publishDelay: 30,
      headless: false,
    },
  });

  const headless = watch('headless');

  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await getSettings();
        reset(data);
      } catch {
        // Backend not running; use defaults
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [reset]);

  const onSubmit = async (values: FormValues) => {
    setSaving(true);
    try {
      await updateSettings(values as Settings);
      toast.success('Налаштування збережено');
    } catch {
      toast.error('Помилка при збереженні налаштувань');
    } finally {
      setSaving(false);
    }
  };

  const handleTestLogin = async () => {
    setTestingLogin(true);
    try {
      const res = await testLogin();
      if (res.success) {
        toast.success(res.message || 'Сесія активна та перевірена!');
      } else {
        toast.error(res.message || 'Помилка авторизації');
      }
    } catch {
      toast.error('Помилка при спробі авторизації');
    } finally {
      setTestingLogin(false);
    }
  };

  const handleOpenBrowser = async () => {
    setOpeningBrowser(true);
    toast('Відкриваємо Google Chrome... Увійдіть у свій акаунт у відкритому вікні.', {
      icon: '🌐',
      duration: 6000,
    });
    try {
      const res = await openBrowserForLogin();
      if (res.success) {
        toast.success(res.message);
      } else {
        toast.error(res.message);
      }
    } catch {
      toast.error('Помилка при запуску браузера');
    } finally {
      setOpeningBrowser(false);
    }
  };

  const handleImportCookies = async () => {
    if (!cookiesText.trim()) return;
    setImportingCookies(true);
    try {
      const res = await importCookies(cookiesText);
      if (res.success) {
        toast.success(res.message);
        setCookiesText('');
      } else {
        toast.error(res.message || 'Не вдалося зберегти кукі');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Помилка при імпорті кукі');
    } finally {
      setImportingCookies(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#00C9A7] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      <h1 className="text-xl font-bold text-gray-900">Налаштування</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {/* Wallapop Account */}
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Обліковий запис Wallapop
          </h2>
          <Card className="flex flex-col gap-4">
            <Input
              {...register('wallapopEmail')}
              label="Email"
              type="email"
              placeholder="your@email.com"
              error={errors.wallapopEmail?.message}
              autoCapitalize="none"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Пароль</label>
              <div className="relative">
                <input
                  {...register('wallapopPassword')}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  className={`w-full rounded-xl border border-gray-200 bg-white px-4 py-3 pr-11 text-sm text-gray-900 placeholder-gray-400 transition-colors focus:border-[#00C9A7] focus:outline-none focus:ring-2 focus:ring-[#00C9A7]/20 ${
                    errors.wallapopPassword ? 'border-red-400' : ''
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {errors.wallapopPassword && (
                <p className="text-xs text-red-500">{errors.wallapopPassword.message}</p>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-2 border-t border-gray-100">
              <Button
                type="button"
                variant="secondary"
                onClick={handleTestLogin}
                loading={testingLogin}
              >
                <LogIn size={16} />
                Автоматична перевірка входу
              </Button>

              <Button
                type="button"
                variant="secondary"
                onClick={handleOpenBrowser}
                loading={openingBrowser}
                className="border-[#00C9A7] text-[#00A88B] hover:bg-[#00C9A7]/10"
              >
                <ExternalLink size={16} />
                Відкрити Wallapop у Chrome (Увійти вручну)
              </Button>
            </div>
          </Card>
        </div>

        {/* Cookie Import / Manual Session */}
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Імпорт сесії / Cookies (Обхід блокування)
          </h2>
          <Card className="flex flex-col gap-3">
            <p className="text-xs text-gray-600 leading-relaxed">
              Якщо Wallapop блокує автоматичний логін повідомленням <b>&quot;Inicio de sesión no disponible&quot;</b>, вставте сюди ваші Cookies з розширення (наприклад, <i>Cookie-Editor</i> або <i>EditThisCookie</i>) або сирий заголовок Cookie:
            </p>
            <textarea
              value={cookiesText}
              onChange={(e) => setCookiesText(e.target.value)}
              placeholder='[ { "name": "...", "value": "..." } ] або name=val; name2=val2'
              rows={4}
              className="w-full rounded-xl border border-gray-200 bg-white p-3 font-mono text-xs text-gray-900 placeholder-gray-400 focus:border-[#00C9A7] focus:outline-none focus:ring-2 focus:ring-[#00C9A7]/20"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={handleImportCookies}
              loading={importingCookies}
              disabled={!cookiesText.trim()}
            >
              <Key size={16} />
              Зберегти та перевірити Cookies
            </Button>
          </Card>
        </div>

        {/* Publication Settings */}
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Налаштування публікації
          </h2>
          <Card className="flex flex-col gap-4">
            <Input
              {...register('publishDelay')}
              label="Затримка між публікаціями (сек)"
              type="number"
              min="5"
              max="3600"
              placeholder="30"
              error={errors.publishDelay?.message}
              hint="Рекомендується 30–120 секунд для уникнення блокування"
            />

            {/* Headless toggle */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-700">Прихований режим</p>
                <p className="mt-0.5 text-xs text-gray-400">
                  Браузер працює у фоновому режимі без відображення вікна
                </p>
              </div>
              <button
                type="button"
                onClick={() => setValue('headless', !headless)}
                className={`relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[#00C9A7]/40 ${
                  headless ? 'bg-[#00C9A7]' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    headless ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </Card>
        </div>

        {/* Warning */}
        <Card className="flex gap-3 bg-amber-50">
          <AlertTriangle size={20} className="mt-0.5 flex-shrink-0 text-amber-500" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Важливо!</p>
            <p className="mt-1 text-xs text-amber-700 leading-relaxed">
              Використовуйте власний акаунт Wallapop. Не публікуйте занадто часто, щоб уникнути
              блокування облікового запису. Рекомендована затримка — не менше 30 секунд.
            </p>
          </div>
        </Card>

        {/* Save */}
        <Button type="submit" size="lg" fullWidth loading={saving} className="rounded-2xl">
          <Save size={18} />
          Зберегти налаштування
        </Button>
      </form>
    </div>
  );
}
