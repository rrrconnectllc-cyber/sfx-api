import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Get dashboard stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const totalFiles = await prisma.file.count({
      where: { organizationId: req.organizationId },
    });

    const sharedToday = await prisma.file.count({
      where: {
        organizationId: req.organizationId,
        createdAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    });

    const activeLinks = await prisma.file.count({
      where: {
        organizationId: req.organizationId,
        expiresAt: { gt: new Date() },
      },
    });

    const totalDownloads = await prisma.file.aggregate({
      where: { organizationId: req.organizationId },
      _sum: { downloadCount: true },
    });

    res.json({
      totalFiles,
      sharedToday,
      activeLinks,
      totalDownloads: totalDownloads._sum.downloadCount || 0,
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get activity feed
router.get('/activity', async (req: AuthRequest, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { organizationId: req.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });

    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

export default router;
