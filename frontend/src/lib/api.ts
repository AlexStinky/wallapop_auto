import axios from 'axios';

export function getApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  if (typeof window !== 'undefined') {
    return '';
  }
  return 'http://127.0.0.1:3001';
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  const body = error.response?.data;
  const message = body?.error?.message ?? body?.message ?? body?.error;
  return typeof message === 'string' && message ? message : fallback;
}

export function getImageUrl(path: string | undefined): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const clean = path.replace(/^\/+/, '');
  return `/${clean}`;
}

const api = axios.create({
  baseURL: typeof window !== 'undefined' ? '/api' : `${getApiBaseUrl().replace(/\/+$/, '')}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProductStatus = 'pending' | 'in_queue' | 'publishing' | 'published' | 'error';

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  category: string;
  subcategory?: string;
  condition: string; // 'new' | 'used_like_new' | 'used_good' | 'used_fair'
  brand?: string;
  model?: string;
  year?: number;
  style?: string;
  material?: string;
  location?: string;
  color?: string;
  weight?: string; // '0-1kg' | '1-2kg' | '2-5kg' | '5-10kg' | '10-20kg' | '20-30kg'
  quantity: number;
  images: string[]; // array of image paths/urls
  status: ProductStatus;
  publishToWallapop?: boolean;
  publishToVinted?: boolean;
  wallapopId?: string;
  wallapopUrl?: string;
  wallapopStatus?: string;
  vintedId?: string;
  vintedUrl?: string;
  vintedStatus?: string;
  vintedCategory?: string;
  vintedSize?: string;
  vintedTitle?: string;
  vintedDescription?: string;
  vintedPrice?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueueStatus {
  isRunning: boolean;
  pending: number;
  processing: string | null;
  completed: number;
  failed: number;
}

export interface Settings {
  wallapopEmail: string;
  wallapopPassword: string;
  vintedEmail?: string;
  vintedPassword?: string;
  publishDelay: number; // seconds between publications
  headless: boolean;
}

export interface NetworkInfo {
  ip: string;
  port: number;
  url: string;
  all: { name: string; ip: string }[];
}

export type CreateProductData = Omit<Product, 'id' | 'wallapopId' | 'errorMessage' | 'createdAt' | 'updatedAt'> & {
  status?: ProductStatus;
  publishNow?: boolean;
};
export type UpdateProductData = {
  [K in keyof CreateProductData]?: CreateProductData[K] | null;
};

// ─── Products ─────────────────────────────────────────────────────────────────

export async function getProducts(): Promise<Product[]> {
  const { data } = await api.get<Product[]>('/products');
  return data;
}

export async function getProduct(id: string): Promise<Product> {
  const { data } = await api.get<Product>(`/products/${id}`, {
    params: { _t: Date.now() },
  });
  return data;
}

export async function createProduct(productData: CreateProductData): Promise<Product> {
  const { data } = await api.post<Product>('/products', productData);
  return data;
}

export async function updateProduct(id: string, productData: UpdateProductData): Promise<Product> {
  const { data } = await api.put<Product>(`/products/${id}`, productData);
  return data;
}

export async function deleteProduct(id: string): Promise<void> {
  await api.delete(`/products/${id}`);
}

export async function publishProduct(id: string, platform?: 'wallapop' | 'vinted' | 'both'): Promise<Product> {
  const { data } = await api.post<Product>(`/products/${id}/publish`, { platform });
  return data;
}

export async function addProductToQueue(id: string): Promise<{ message: string; productId: string }> {
  const { data } = await api.post<{ message: string; productId: string }>(`/products/${id}/queue`);
  return data;
}

export async function publishProductNow(id: string, platform?: 'wallapop' | 'vinted' | 'both'): Promise<{ message: string; productId: string }> {
  const { data } = await api.post<{ message: string; productId: string }>(`/products/${id}/publish-now`, { platform });
  return data;
}

export async function publishAllProducts(): Promise<{ message: string; count: number }> {
  const { data } = await api.post<{ message: string; count: number }>('/products/publish-all');
  return data;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export async function getQueue(): Promise<QueueStatus> {
  const { data } = await api.get<QueueStatus>('/queue');
  return data;
}

export async function startQueue(): Promise<QueueStatus> {
  const { data } = await api.post<QueueStatus>('/queue/start');
  return data;
}

export async function stopQueue(): Promise<QueueStatus> {
  const { data } = await api.post<QueueStatus>('/queue/stop');
  return data;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const { data } = await api.get<Settings>('/settings');
  return data;
}

export async function updateSettings(settingsData: Settings): Promise<Settings> {
  const { data } = await api.put<Settings>('/settings', settingsData);
  return data;
}

export async function testLogin(): Promise<{ success: boolean; message: string }> {
  const { data } = await api.post<{ success: boolean; message: string }>('/settings/test-login');
  return data;
}

export async function importCookies(cookies: string): Promise<{ success: boolean; message: string; count?: number; sessionActive?: boolean }> {
  const { data } = await api.post<{ success: boolean; message: string; count?: number; sessionActive?: boolean }>('/settings/import-cookies', { cookies });
  return data;
}

export async function openBrowserForLogin(): Promise<{ success: boolean; message: string }> {
  const { data } = await api.post<{ success: boolean; message: string }>('/settings/open-browser');
  return data;
}

export async function testVintedLogin(): Promise<{ success: boolean; message: string }> {
  const { data } = await api.post<{ success: boolean; message: string }>('/settings/vinted/test-login');
  return data;
}

export async function importVintedCookies(cookies: string): Promise<{ success: boolean; message: string; count?: number; sessionActive?: boolean }> {
  const { data } = await api.post<{ success: boolean; message: string; count?: number; sessionActive?: boolean }>('/settings/vinted/import-cookies', { cookies });
  return data;
}

export async function openVintedBrowserForLogin(): Promise<{ success: boolean; message: string }> {
  const { data } = await api.post<{ success: boolean; message: string }>('/settings/vinted/open-browser');
  return data;
}

export async function clearVintedCookies(): Promise<{ success: boolean; message: string }> {
  const { data } = await api.delete<{ success: boolean; message: string }>('/settings/vinted/cookies');
  return data;
}

export async function clearWallapopCookies(): Promise<{ success: boolean; message: string }> {
  const { data } = await api.delete<{ success: boolean; message: string }>('/settings/cookies');
  return data;
}

export async function getNetworkInfo(): Promise<NetworkInfo> {
  const { data } = await api.get<NetworkInfo>('/settings/network-info');
  return data;
}

// ─── Images ───────────────────────────────────────────────────────────────────

export async function uploadImages(files: File[]): Promise<string[]> {
  if (!files || files.length === 0) return [];

  // Upload images individually in parallel so no request ever hits proxy/buffer limits
  const uploadPromises = files.map(async (file) => {
    const formData = new FormData();
    formData.append('images', file);
    const { data } = await api.post<{ urls: string[] }>('/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return data.urls;
  });

  const results = await Promise.all(uploadPromises);
  return results.flat();
}

export default api;
