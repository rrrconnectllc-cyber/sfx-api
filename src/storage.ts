import fs from 'fs';
import path from 'path';

export const UPLOADS_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), 'uploads');

export function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export function storedFilePath(fileId: string) {
  return path.join(UPLOADS_DIR, fileId);
}

export function resolveStoredFile(storedPath: string, fileId: string) {
  if (storedPath && fs.existsSync(storedPath)) return storedPath;
  const inVolume = storedFilePath(fileId);
  if (fs.existsSync(inVolume)) return inVolume;
  const byName = path.join(UPLOADS_DIR, path.basename(storedPath || ''));
  if (storedPath && fs.existsSync(byName)) return byName;
  return storedPath;
}
