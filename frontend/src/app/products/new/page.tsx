'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  Sparkles,
  ChevronDown,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import { createProduct, uploadImages } from '@/lib/api';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';

// ─── Validation schema ─────────────────────────────────────────────────────────

const schema = z.object({
  images: z.array(z.instanceof(File)).min(1, 'Añade al menos una foto'),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  title: z.string().min(3, 'Mínimo 3 caracteres').max(50, 'Máximo 50 caracteres'),
  description: z.string().min(10, 'Mínimo 10 caracteres').max(640, 'Máximo 640 caracteres'),
  condition: z.string().min(1, 'Selecciona el estado'),
  brand: z.string().optional(),
  model: z.string().optional(),
  year: z.string().optional(),
  style: z.string().optional(),
  material: z.string().optional(),
  location: z.string().optional(),
  color: z.string().optional(),
  price: z.coerce.number().positive('Indica un precio válido'),
  quantity: z.coerce.number().int().positive('La cantidad debe ser mayor que 0'),
  weight: z.string().min(1, 'Selecciona el peso'),
});

type FormValues = z.infer<typeof schema>;

const conditionOptions = [
  { value: 'new', label: 'Nuevo', desc: 'Nunca se ha usado' },
  { value: 'used_like_new', label: 'Como nuevo', desc: 'En perfectas condiciones' },
  { value: 'used_good', label: 'En buen estado', desc: 'Con alguna señal de uso' },
  { value: 'used_fair', label: 'Aceptable', desc: 'Funciona, pero tiene desperfectos' },
  { value: 'poor', label: 'Para piezas', desc: 'No funciona o necesita reparación' },
];

const colorOptions = [
  'Negro',
  'Blanco',
  'Gris',
  'Azul',
  'Rojo',
  'Verde',
  'Amarillo',
  'Marrón',
  'Naranja',
  'Rosa',
  'Morado',
  'Plateado',
  'Dorado',
];

const styleOptions = [
  'Road bike',
  'Scooter',
  'Off-road',
  'Moped',
  'Trike',
  'Supermoto',
  'Sportbike',
  'Naked',
  'Adventure',
  'Motocross',
  'Enduro',
  'Cruiser',
  'Touring',
  'Trial',
  'Maxiscooter',
  'Kids bike',
];

const weightOptions = [
  { value: '0-1kg', label: '0 a 1 kg' },
  { value: '1-2kg', label: '1 a 2 kg' },
  { value: '2-5kg', label: '2 a 5 kg', recommended: true },
  { value: '5-10kg', label: '5 a 10 kg' },
  { value: '10-20kg', label: '10 a 20 kg' },
  { value: '20-30kg', label: '20 a 30 kg' },
];

export default function NewProductPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showExtraFields, setShowExtraFields] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      images: [],
      category: '',
      subcategory: '',
      quantity: 1,
      condition: 'used_like_new',
      weight: '2-5kg',
    },
  });

  const selectedImages = watch('images') || [];
  const watchCategory = watch('category') || '';
  const watchTitle = watch('title') || '';
  const watchDescription = watch('description') || '';

  // Local object URLs for photo preview
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const combined = [...selectedImages, ...files].slice(0, 10);
    setValue('images', combined, { shouldValidate: true });

    const urls = combined.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemovePhoto = (index: number) => {
    const updated = selectedImages.filter((_, i) => i !== index);
    setValue('images', updated, { shouldValidate: true });
    setPreviewUrls(previewUrls.filter((_, i) => i !== index));
  };

  const onSubmit = async (values: FormValues) => {
    const mode = (typeof window !== 'undefined' && (window as any).__productSubmitMode === 'publish_now')
      ? 'publish_now'
      : 'queue';

    setSubmitting(true);
    const queueBtn = document.getElementById('btn-add-to-queue') as HTMLButtonElement | null;
    const publishBtn = document.getElementById('btn-publish-now') as HTMLButtonElement | null;
    if (queueBtn) queueBtn.disabled = true;
    if (publishBtn) publishBtn.disabled = true;

    if (mode === 'publish_now' && publishBtn) {
      publishBtn.textContent = 'Публікація...';
    } else if (queueBtn) {
      queueBtn.textContent = 'Збереження...';
    }

    try {
      let imagePaths: string[] = [];
      if (values.images.length > 0) {
        imagePaths = await uploadImages(values.images);
      }

      await createProduct({
        title: values.title,
        description: values.description,
        price: values.price,
        category: values.category?.trim() || values.title.trim().slice(0, 50),
        subcategory: undefined,
        condition: values.condition,
        brand: values.brand?.trim() || undefined,
        model: values.model?.trim() || undefined,
        year: values.year && !isNaN(parseInt(values.year, 10)) ? parseInt(values.year, 10) : undefined,
        style: values.style?.trim() || undefined,
        material: values.material?.trim() || undefined,
        location: values.location?.trim() || undefined,
        color: values.color?.trim() || undefined,
        weight: values.weight,
        quantity: values.quantity,
        images: imagePaths,
        status: 'in_queue',
        publishNow: mode === 'publish_now',
      });

      if (mode === 'publish_now') {
        toast.success('Товар створено, публікацію запущено!');
      } else {
        toast.success('Товар додано до черги!');
      }
      router.push('/products');
    } catch {
      toast.error('Помилка при збереженні товару');
      if (queueBtn) {
        queueBtn.disabled = false;
        queueBtn.textContent = 'Додати в чергу';
      }
      if (publishBtn) {
        publishBtn.disabled = false;
        publishBtn.textContent = 'Опублікувати зараз';
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-[#192A3E]">
      {/* ── Top Header ────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center gap-3 bg-white/95 px-4 py-3.5 backdrop-blur-md border-b border-gray-100">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-gray-100 active:scale-95 transition-colors"
        >
          <ArrowLeft size={22} className="text-[#192A3E]" />
        </button>
        <h1 className="text-xl font-bold tracking-tight text-[#192A3E]">
          Detalles del producto
        </h1>
      </header>

      {/* ── Main Content Container ────────────────────────────── */}
      <main className="mx-auto max-w-xl px-4 pt-3 pb-44">
        {/* Banner: Revisa la información */}
        <div className="flex items-start gap-3.5 rounded-2xl bg-[#EDF5F7] p-4 text-[#192A3E]">
          <div className="mt-0.5 text-[#015354]">
            <Sparkles size={22} className="fill-[#015354]/20 text-[#015354]" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-bold text-[#015354]">Revisa la información</h2>
            <p className="mt-0.5 text-xs text-[#2A4345] leading-relaxed">
              Hemos rellenado algunos detalles por ti. Completa los que faltan para terminar.
            </p>
          </div>
        </div>

        {/* ── Form ─────────────────────────────────────────────── */}
        <form id="product-form" onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-3.5">
          <button id="product-form-hidden-submit" type="submit" className="hidden" />
          {/* Photos Row (matching screenshot) */}
          <div>
            <div className="flex items-center gap-3 overflow-x-auto pb-2 pt-1 no-scrollbar">
              {/* Uploaded photos */}
              {previewUrls.map((url, idx) => (
                <div
                  key={idx}
                  className="relative h-28 w-28 flex-shrink-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-sm"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Foto ${idx + 1}`} className="h-full w-full object-cover" />

                  {/* Foto principal pill badge */}
                  {idx === 0 && (
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/95 px-2.5 py-0.5 text-[10px] font-semibold text-gray-700 shadow-sm border border-gray-100">
                      Foto principal
                    </div>
                  )}

                  {/* Delete button */}
                  <button
                    type="button"
                    onClick={() => handleRemovePhoto(idx)}
                    className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                  >
                    <X size={11} strokeWidth={3} />
                  </button>
                </div>
              ))}

              {/* Add Photo Slot (placeholder with photo icon) */}
              {selectedImages.length < 10 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="relative flex h-28 w-28 flex-shrink-0 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-white hover:border-[#00C9A7] hover:bg-[#00C9A7]/5 transition-all active:scale-95"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl text-[#5A738E]">
                    <ImageIcon size={32} strokeWidth={1.5} />
                  </div>
                  <span className="text-[11px] font-medium text-gray-500 mt-1">Añadir foto</span>
                </button>
              )}

              {/* Extra dummy placeholder slot like in the screenshot */}
              {selectedImages.length === 0 && (
                <div className="flex h-28 w-28 flex-shrink-0 flex-col items-center justify-center rounded-2xl border border-gray-200 bg-white opacity-40">
                  <ImageIcon size={32} strokeWidth={1.5} className="text-[#5A738E]" />
                </div>
              )}
            </div>

            {/* Hidden native input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={handleFilesSelected}
              className="hidden"
            />
            {errors.images && (
              <p className="mt-1 text-xs text-red-500">{errors.images.message}</p>
            )}
          </div>

          {/* ── Card 1: Опис товару для підбору категорії (Resumen) ─────── */}
          <div className="rounded-2xl border border-gray-200 p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-normal text-gray-500">
                Опис товару (для автопідбору категорії на Wallapop)
              </label>
              <span className="text-[11px] text-gray-400">
                {(watchCategory || watchTitle).slice(0, 50).length}/50
              </span>
            </div>
            <input
              {...register('category')}
              type="text"
              maxLength={50}
              placeholder="Наприклад: Cafetera italiana Bialetti, Sofá de piel..."
              className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-1"
            />
            <p className="mt-1.5 text-[11px] text-gray-400 leading-normal">
              Введіть короткий опис (до 50 симв.). Сайт Wallapop сам підбере категорію та підкатегорії на основі цього тексту. Якщо залишити порожнім — бот автоматично використає назву товару.
            </p>
          </div>

          {/* ── Card 2: Marca* ───────────────────────────────── */}
          <div
            className={cn(
              'rounded-2xl border p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10',
              errors.brand ? 'border-red-400' : 'border-gray-200'
            )}
          >
            <label className="block text-xs font-normal text-gray-500">Marca*</label>
            <input
              {...register('brand')}
              type="text"
              placeholder="Ej: Apple, Honda, Sony"
              className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
            />
          </div>

          {/* ── Card 3: Color* ───────────────────────────────── */}
          <div className="relative rounded-2xl border border-gray-200 p-4 bg-white transition-all focus-within:border-[#00C9A7]">
            <label className="block text-xs font-normal text-gray-500">Color*</label>
            <select
              {...register('color')}
              className="w-full text-base font-semibold text-gray-900 bg-transparent focus:outline-none cursor-pointer mt-0.5 appearance-none pr-8"
            >
              <option value="">Seleccionar color...</option>
              {colorOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <ChevronDown size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>

          {/* ── Card 4: Título* ──────────────────────────────── */}
          <div
            className={cn(
              'rounded-2xl border p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10',
              errors.title ? 'border-red-400' : 'border-gray-200'
            )}
          >
            <div className="flex items-center justify-between">
              <label className="block text-xs font-normal text-gray-500">Título*</label>
              <span className="text-xs text-gray-400">{watchTitle.length}/50</span>
            </div>
            <input
              {...register('title')}
              type="text"
              maxLength={50}
              placeholder="¿Qué vendes? (Ej: iPhone 14 Pro 128GB)"
              className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
            />
            {errors.title && (
              <p className="mt-1 text-xs text-red-500">{errors.title.message}</p>
            )}
          </div>

          {/* ── Card 5: Descripción* ─────────────────────────── */}
          <div
            className={cn(
              'rounded-2xl border p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10',
              errors.description ? 'border-red-400' : 'border-gray-200'
            )}
          >
            <div className="flex items-center justify-between">
              <label className="block text-xs font-normal text-gray-500">Descripción*</label>
              <span className="text-xs text-gray-400">{watchDescription.length}/640</span>
            </div>
            <textarea
              {...register('description')}
              rows={3}
              maxLength={640}
              placeholder="Añade información relevante sobre el producto (estado, motivos de venta, características...)"
              className="w-full text-sm text-gray-800 placeholder:text-gray-300 focus:outline-none bg-transparent mt-1.5 resize-none leading-relaxed"
            />
            {errors.description && (
              <p className="mt-1 text-xs text-red-500">{errors.description.message}</p>
            )}
          </div>

          {/* ── Card 6: Estado* ──────────────────────────────── */}
          <div className="relative rounded-2xl border border-gray-200 p-4 bg-white transition-all focus-within:border-[#00C9A7]">
            <label className="block text-xs font-normal text-gray-500">Estado*</label>
            <select
              {...register('condition')}
              className="w-full text-base font-semibold text-gray-900 bg-transparent focus:outline-none cursor-pointer mt-0.5 appearance-none pr-8"
            >
              {conditionOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label} ({c.desc})
                </option>
              ))}
            </select>
            <ChevronDown size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>

          {/* ── Card 7: Precio* ──────────────────────────────── */}
          <div
            className={cn(
              'rounded-2xl border p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10',
              errors.price ? 'border-red-400' : 'border-gray-200'
            )}
          >
            <label className="block text-xs font-normal text-gray-500">Precio*</label>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xl font-bold text-gray-900">€</span>
              <input
                {...register('price')}
                type="number"
                step="0.01"
                placeholder="0.00"
                className="w-full text-xl font-bold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent"
              />
            </div>
            {errors.price && (
              <p className="mt-1 text-xs text-red-500">{errors.price.message}</p>
            )}
          </div>

          {/* ── Card 8: ¿Cuánto pesa? (Envío) ────────────────── */}
          <div className="rounded-2xl border border-gray-200 p-4 bg-white">
            <label className="block text-xs font-normal text-gray-500 mb-2.5">¿Cuánto pesa?*</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {weightOptions.map((w) => {
                const currentWeight = watch('weight');
                const isSelected = currentWeight === w.value;
                return (
                  <button
                    key={w.value}
                    type="button"
                    onClick={() => setValue('weight', w.value, { shouldValidate: true })}
                    className={cn(
                      'rounded-xl border py-2.5 px-3 text-xs font-semibold text-center transition-all',
                      isSelected
                        ? 'border-[#00C9A7] bg-[#00C9A7]/10 text-[#008F75]'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300'
                    )}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Optional Extra Details Toggle ────────────────── */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowExtraFields(!showExtraFields)}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-900 transition-colors"
            >
              <ChevronDown
                size={16}
                className={cn('transition-transform duration-200', showExtraFields && 'rotate-180')}
              />
              {showExtraFields ? 'Ocultar campos adicionales' : 'Ver campos adicionales (Modelo, Año, Estilo, etc.)'}
            </button>
          </div>

          {showExtraFields && (
            <div className="space-y-3.5 pt-1">
              {/* Modelo */}
              <div className="rounded-2xl border border-gray-200 p-4 bg-white focus-within:border-[#00C9A7]">
                <label className="block text-xs font-normal text-gray-500">Modelo (Opcional)</label>
                <input
                  {...register('model')}
                  type="text"
                  placeholder="Ej: CB650R, Pro Max"
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              {/* Año */}
              <div className="rounded-2xl border border-gray-200 p-4 bg-white focus-within:border-[#00C9A7]">
                <label className="block text-xs font-normal text-gray-500">Año (Opcional)</label>
                <input
                  {...register('year')}
                  type="number"
                  placeholder="Ej: 2023"
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              {/* Estilo */}
              <div className="relative rounded-2xl border border-gray-200 p-4 bg-white focus-within:border-[#00C9A7]">
                <label className="block text-xs font-normal text-gray-500">Estilo / Tipo (Opcional)</label>
                <select
                  {...register('style')}
                  className="w-full text-base font-semibold text-gray-900 bg-transparent focus:outline-none cursor-pointer mt-0.5 appearance-none pr-8"
                >
                  <option value="">No especificado</option>
                  {styleOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <ChevronDown size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" />
              </div>

              {/* Material */}
              <div className="rounded-2xl border border-gray-200 p-4 bg-white focus-within:border-[#00C9A7]">
                <label className="block text-xs font-normal text-gray-500">Material (Opcional)</label>
                <input
                  {...register('material')}
                  type="text"
                  placeholder="Ej: Aluminio, Cuero, Madera"
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              {/* Ubicación */}
              <div className="rounded-2xl border border-gray-200 p-4 bg-white focus-within:border-[#00C9A7]">
                <label className="block text-xs font-normal text-gray-500">Ubicación / Código Postal (Opcional)</label>
                <input
                  {...register('location')}
                  type="text"
                  placeholder="Ej: Madrid, 28001"
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
