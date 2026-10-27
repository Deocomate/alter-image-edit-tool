import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve('data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

const IMAGE_ID = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const SESSION_ID = /^[0-9a-f-]{36}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function initStore() {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

export const imageUrl = (id) => `/images/${id}`;

export async function saveImage(buffer, ext) {
  const id = `${randomUUID()}.${ext}`;
  await fs.writeFile(path.join(IMAGES_DIR, id), buffer);
  return id;
}

export async function readImage(id) {
  if (!IMAGE_ID.test(id)) throw new HttpError(400, 'Mã ảnh không hợp lệ');
  try {
    return await fs.readFile(path.join(IMAGES_DIR, id));
  } catch {
    throw new HttpError(404, 'Không tìm thấy ảnh');
  }
}

const sessionPath = (id) => {
  if (!SESSION_ID.test(id)) throw new HttpError(400, 'Mã phiên không hợp lệ');
  return path.join(SESSIONS_DIR, `${id}.json`);
};

export async function createSession() {
  const now = new Date().toISOString();
  const session = { id: randomUUID(), title: 'Phiên chỉnh sửa mới', createdAt: now, updatedAt: now, messages: [] };
  await saveSession(session);
  return session;
}

export async function getSession(id) {
  try {
    return JSON.parse(await fs.readFile(sessionPath(id), 'utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'Không tìm thấy phiên');
  }
}

export async function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  const file = sessionPath(session.id);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(session, null, 2));
  await fs.rename(`${file}.tmp`, file);
}

export async function listSessions() {
  const files = (await fs.readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
  const sessions = await Promise.all(
    files.map(async (f) => {
      const { id, title, updatedAt } = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
      return { id, title, updatedAt };
    }),
  );
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSession(id) {
  const session = await getSession(id);
  const imageIds = new Set(session.messages.flatMap((m) => (m.images || []).map((img) => img.id)));
  for (const m of session.messages) if (m.maskId) imageIds.add(m.maskId);
  await Promise.all([...imageIds].map((imgId) => fs.rm(path.join(IMAGES_DIR, imgId), { force: true })));
  await fs.rm(sessionPath(id), { force: true });
}
