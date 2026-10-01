'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  ChevronDown,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import { getProduct, updateProduct, uploadImages, getImageUrl } from '@/lib/api';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';

// ─── Validation schema ─────────────────────────────────────────────────────────

const schema = z.object({
  category: z.string().optional(),
  subcategory: z.string().optional(),
  title: z.string().min(1, 'Вкажіть назву товару').max(60, 'Максимум 60 символів'),
  description: z.string().min(1, 'Вкажіть опис товару').max(2000, 'Максимум 2000 символів'),
  condition: z.string().min(1, 'Виберіть стан товару'),
  brand: z.string().optional(),
  model: z.string().optional(),
  year: z.string().optional(),
  style: z.string().optional(),
  material: z.string().optional(),
  location: z.string().optional(),
  color: z.string().optional(),
  price: z.coerce.number().positive('Вкажіть коректну ціну'),
  quantity: z.coerce.number().int().positive('Кількість повинна бути більше 0'),
  weight: z.string().min(1, 'Виберіть вагу / розмір'),
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

interface ImageItem {
  type: 'existing' | 'new';
  url: string;
  file?: File;
  originalPath?: string;
}

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showExtraFields, setShowExtraFields] = useState(false);
  const [images, setImages] = useState<ImageItem[]>([]);

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      category: '',
      subcategory: '',
      quantity: 1,
      condition: 'used_like_new',
      weight: '2-5kg',
    },
  });

  const watchCategory = watch('category') || '';
  const watchTitle = watch('title') || '';
  const watchDescription = watch('description') || '';

  useEffect(() => {
    async function loadProduct() {
      try {
        const prod = await getProduct(id);
        reset({
          title: prod.title || '',
          description: prod.description || '',
          price: prod.price || 0,
          category: prod.category || '',
          subcategory: prod.subcategory || '',
          condition: prod.condition || 'used_like_new',
          brand: prod.brand || '',
          model: prod.model || '',
          year: prod.year ? String(prod.year) : '',
          style: prod.style || '',
          material: prod.material || '',
          location: prod.location || '',
          color: prod.color || '',
          weight: prod.weight || '2-5kg',
          quantity: prod.quantity || 1,
        });

        if (prod.brand || prod.model || prod.year || prod.style || prod.material || prod.location) {
          setShowExtraFields(true);
        }

        const existingItems: ImageItem[] = (prod.images || []).map((path) => ({
          type: 'existing',
          url: getImageUrl(path),
          originalPath: path,
        }));
        setImages(existingItems);
      } catch (err) {
        toast.error('Товар не знайдено');
        router.push('/products');
      } finally {
        setLoading(false);
      }
    }

    if (id) {
      loadProduct();
    }
  }, [id, reset, router]);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const availableSlots = 10 - images.length;
    const toAdd = files.slice(0, availableSlots).map((file) => ({
      type: 'new' as const,
      url: URL.createObjectURL(file),
      file,
    }));

    setImages((prev) => [...prev, ...toAdd]);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemovePhoto = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const onSubmit = async (values: FormValues) => {
    if (images.length === 0) {
      toast.error('Додайте хоча б одну фотографію');
      return;
    }

    setSubmitting(true);
    const saveBtn = document.getElementById('btn-save-product') as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Збереження...';
    }

    try {
      // 1. Separate existing images and new files
      const existingPaths = images
        .filter((it) => it.type === 'existing' && it.originalPath)
        .map((it) => it.originalPath!);

      const newFiles = images
        .filter((it) => it.type === 'new' && it.file)
        .map((it) => it.file!);

      // 2. Upload newly added files
      let uploadedPaths: string[] = [];
      if (newFiles.length > 0) {
        uploadedPaths = await uploadImages(newFiles);
      }

      const allImages = [...existingPaths, ...uploadedPaths];

      // 3. Update product in DB
      await updateProduct(id, {
        title: values.title.trim(),
        description: values.description.trim(),
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
        images: allImages,
      });

      toast.success('Зміни успішно збережено!');
      router.push(`/products/${id}`);
    } catch (err: any) {
      const errMsg = err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || 'Помилка при збереженні змін';
      toast.error(errMsg);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Зберегти зміни';
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onError = (formErrors: any) => {
    const errorList = Object.values(formErrors) as any[];
    if (errorList.length > 0 && errorList[0]?.message) {
      toast.error(errorList[0].message);
    } else {
      toast.error('Будь ласка, заповніть обов\'язкові поля');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#00C9A7] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-[#192A3E]">
      {/* ── Top Header ────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center justify-between bg-white/95 px-4 py-3.5 backdrop-blur-md border-b border-gray-100">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-gray-100 active:scale-95 transition-colors"
          >
            <ArrowLeft size={22} className="text-[#192A3E]" />
          </button>
          <h1 className="text-xl font-bold tracking-tight text-[#192A3E]">
            Редагувати товар
          </h1>
        </div>
      </header>

      {/* ── Main Content Container ────────────────────────────── */}
      <main className="mx-auto max-w-xl px-4 pt-3 pb-36">
        <form
          id="product-form"
          onSubmit={handleSubmit(onSubmit, onError)}
          className="mt-5 space-y-3.5"
        >
          {/* Hidden submit button triggered by BottomNav */}
          <button
            id="product-form-hidden-submit"
            type="submit"
            disabled={submitting}
            className="hidden"
          />

          {/* Photos Row */}
          <div>
            <div className="flex items-center gap-3 overflow-x-auto pb-2 pt-1 no-scrollbar">
              {/* Image previews */}
              {images.map((item, idx) => (
                <div
                  key={idx}
                  className="relative h-28 w-28 flex-shrink-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-sm"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt={`Foto ${idx + 1}`} className="h-full w-full object-cover" />

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

              {/* Add Photo Slot */}
              {images.length < 10 && (
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
            {images.length === 0 && (
              <p className="mt-1 text-xs text-red-500">Додайте хоча б одну фотографію</p>
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
          </div>

          {/* ── Card 2: Marca ───────────────────────────────── */}
          <div className="rounded-2xl border border-gray-200 p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10">
            <label className="block text-xs font-normal text-gray-500">Marca</label>
            <input
              {...register('brand')}
              type="text"
              placeholder="Ej: Apple, Honda, Sony"
              className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
            />
          </div>

          {/* ── Card 3: Color ───────────────────────────────── */}
          <div className="relative rounded-2xl border border-gray-200 p-4 bg-white transition-all focus-within:border-[#00C9A7]">
            <label className="block text-xs font-normal text-gray-500">Color</label>
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
            <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">
              <ChevronDown size={20} />
            </div>
          </div>

          {/* ── Card 4: Título* ───────────────────────────────── */}
          <div
            className={cn(
              'rounded-2xl border p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10',
              errors.title ? 'border-red-400' : 'border-gray-200'
            )}
          >
            <div className="flex items-center justify-between">
              <label className="block text-xs font-normal text-gray-500">Título*</label>
              <span className="text-[11px] text-gray-400">{watchTitle.length}/50</span>
            </div>
            <input
              {...register('title')}
              type="text"
              maxLength={50}
              placeholder="¿Qué vendes? (Ej: iPhone 14 Pro 128GB)"
              className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
            />
            {errors.title && <p className="mt-1 text-xs text-red-500">{errors.title.message}</p>}
          </div>

          {/* ── Card 5: Descripción* ───────────────────────────── */}
          <div
            className={cn(
              'rounded-2xl border p-4 bg-white transition-all focus-within:border-[#00C9A7] focus-within:ring-2 focus-within:ring-[#00C9A7]/10',
              errors.description ? 'border-red-400' : 'border-gray-200'
            )}
          >
            <div className="flex items-center justify-between">
              <label className="block text-xs font-normal text-gray-500">Descripción*</label>
              <span className="text-[11px] text-gray-400">{watchDescription.length}/640</span>
            </div>
            <textarea
              {...register('description')}
              rows={4}
              maxLength={640}
              placeholder="Añade información relevante sobre el producto (estado, motivos de venta, características...)"
              className="w-full resize-none text-base font-normal text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-1"
            />
            {errors.description && (
              <p className="mt-1 text-xs text-red-500">{errors.description.message}</p>
            )}
          </div>

          {/* ── Card 6: Estado* ───────────────────────────────── */}
          <div className="relative rounded-2xl border border-gray-200 p-4 bg-white transition-all focus-within:border-[#00C9A7]">
            <label className="block text-xs font-normal text-gray-500">Estado*</label>
            <select
              {...register('condition')}
              className="w-full text-base font-bold text-gray-900 bg-transparent focus:outline-none cursor-pointer mt-0.5 appearance-none pr-8"
            >
              {conditionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.desc})
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">
              <ChevronDown size={20} />
            </div>
          </div>

          {/* ── Card 7: Precio* ───────────────────────────────── */}
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
            {errors.price && <p className="mt-1 text-xs text-red-500">{errors.price.message}</p>}
          </div>

          {/* ── Card 8: ¿Cuánto pesa?* (Weight) ──────────────── */}
          <div className="rounded-2xl border border-gray-200 p-4 bg-white">
            <div className="flex items-center justify-between mb-3">
              <label className="block text-xs font-normal text-gray-500">¿Cuánto pesa?*</label>
              <span className="text-[11px] text-gray-400">Для доставки</span>
            </div>
            <Controller
              name="weight"
              control={control}
              render={({ field }) => (
                <div className="grid grid-cols-3 gap-2">
                  {weightOptions.map((opt) => {
                    const isSelected = field.value === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => field.onChange(opt.value)}
                        className={cn(
                          'flex items-center justify-center rounded-xl border py-2.5 text-xs font-semibold transition-all',
                          isSelected
                            ? 'border-[#00C9A7] bg-[#00C9A7]/10 text-[#00C9A7] font-bold'
                            : 'border-gray-200 text-gray-700 hover:border-gray-300'
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            />
          </div>

          {/* ── Toggle extra fields ────────────────────────────── */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowExtraFields(!showExtraFields)}
              className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              <ChevronDown
                size={16}
                className={cn('transition-transform duration-200', showExtraFields && 'rotate-180')}
              />
              {showExtraFields
                ? 'Приховати додаткові поля'
                : 'Ver campos adicionales (Modelo, Año, Estilo, etc.)'}
            </button>
          </div>

          {/* ── Extra fields ───────────────────────────────────── */}
          {showExtraFields && (
            <div className="space-y-3 pt-2">
              <div className="rounded-2xl border border-gray-200 p-4 bg-white">
                <label className="block text-xs font-normal text-gray-500">Modelo</label>
                <input
                  {...register('model')}
                  type="text"
                  placeholder="Ej: Pro Max, Series 8..."
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              <div className="rounded-2xl border border-gray-200 p-4 bg-white">
                <label className="block text-xs font-normal text-gray-500">Año</label>
                <input
                  {...register('year')}
                  type="number"
                  placeholder="Ej: 2022"
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              <div className="relative rounded-2xl border border-gray-200 p-4 bg-white">
                <label className="block text-xs font-normal text-gray-500">Estilo</label>
                <select
                  {...register('style')}
                  className="w-full text-base font-semibold text-gray-900 bg-transparent focus:outline-none cursor-pointer mt-0.5 appearance-none pr-8"
                >
                  <option value="">Seleccionar estilo...</option>
                  {styleOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">
                  <ChevronDown size={20} />
                </div>
              </div>

              <div className="rounded-2xl border border-gray-200 p-4 bg-white">
                <label className="block text-xs font-normal text-gray-500">Material</label>
                <input
                  {...register('material')}
                  type="text"
                  placeholder="Ej: Cuero, Aluminio, Madera..."
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              <div className="rounded-2xl border border-gray-200 p-4 bg-white">
                <label className="block text-xs font-normal text-gray-500">Ubicación (Місто/Локація)</label>
                <input
                  {...register('location')}
                  type="text"
                  placeholder="Ej: Madrid, Barcelona..."
                  className="w-full text-base font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none bg-transparent mt-0.5"
                />
              </div>

              <div className="rounded-2xl border border-gray-200 p-4 bg-white">
                <label className="block text-xs font-normal text-gray-500">Кількість (Quantity)</label>
                <input
                  {...register('quantity')}
                  type="number"
                  min={1}
                  className="w-full text-base font-semibold text-gray-900 focus:outline-none bg-transparent mt-0.5"
                />
              </div>
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
