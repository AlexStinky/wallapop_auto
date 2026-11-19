import * as fs from 'fs';
import * as path from 'path';

const extensions = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
  ['image/gif', '.gif'], ['image/avif', '.avif'], ['image/heic', '.heic'],
  ['image/heif', '.heif'], ['image/bmp', '.bmp'], ['image/tiff', '.tiff'],
]);

export function imageExtension(mime: string) {
  return extensions.get(mime.toLowerCase());
}

export function resolveUploadedPhoto(reference: string): string | null {
  // Older records contain full paths. Only their filename refers to an upload.
  const name = path.win32.basename(reference);
  if (!name || /[:\x00-\x1f]/.test(name) || !/\.(?:jpe?g|jfif|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(name)) return null;
  const file = path.resolve(process.env.UPLOAD_DIR || './uploads', name);
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}
