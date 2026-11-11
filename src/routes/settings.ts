import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Get settings
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.organizationSettings.findUnique({
      where: { organizationId: req.organizationId },
      include: { organization: { select: { name: true } } },
    });

    if (!settings) {
      return res.status(404).json({ error: 'Settings not found' });
    }

    const { organization, ...rest } = settings;
    res.json({ ...rest, organizationName: organization.name });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update settings
router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      organizationName,
      defaultExpiration,
      maxDownloads,
      requirePassword,
      enableEmailNotifications,
      enableTwoFactor,
    } = req.body;

    const settings = await prisma.organizationSettings.update({
      where: { organizationId: req.organizationId },
      data: {
        defaultExpiration: defaultExpiration || 30,
        maxDownloads: maxDownloads || 100,
        requirePassword: requirePassword === true,
        enableEmailNotify: enableEmailNotifications === true,
        enableTwoFactor: enableTwoFactor ?? false,
      },
    });

    if (organizationName) {
      await prisma.organization.update({
        where: { id: req.organizationId },
        data: { name: organizationName },
      });
    }

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'SETTINGS_UPDATED',
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true, settings });
  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
