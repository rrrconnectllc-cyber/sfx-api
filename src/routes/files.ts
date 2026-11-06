import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Get recent files
router.get('/recent', async (req: AuthRequest, res: Response) => {
  try {
    const files = await prisma.file.findMany({
      where: { organizationId: req.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        name: true,
        size: true,
        createdAt: true,
        downloadCount: true,
        expiresAt: true,
      },
    });

    const formatted = files.map(f => ({
      id: f.id,
      name: f.name,
      size: formatSize(Number(f.size)),
      sharedDate: formatDate(f.createdAt),
      downloads: f.downloadCount,
      status: new Date(f.expiresAt) > new Date() ? 'active' : 'expired',
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Get all files
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const files = await prisma.file.findMany({
      where: { organizationId: req.organizationId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(files);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Delete file
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const file = await prisma.file.findUnique({ where: { id } });
    if (!file || file.organizationId !== req.organizationId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.file.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        fileId: id,
        action: 'FILE_DELETED',
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Utility functions
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + ' ' + sizes[i];
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export default router;
