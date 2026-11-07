import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Get organization details
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.organizationId },
      include: {
        users: { select: { id: true, userId: true, role: true } },
        _count: { select: { files: true, users: true } },
      },
    });

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: req.organizationId, userId: req.userId },
    });

    res.json({
      id: org.id,
      name: org.name,
      plan: org.plan,
      createdAt: org.createdAt,
      memberCount: org._count.users,
      fileCount: org._count.files,
      role: member?.role ?? 'member',
    });
  } catch (error) {
    console.error('Get org error:', error);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

// Update organization
router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, plan } = req.body;
    const plans = ['trial', 'starter', 'business', 'enterprise'];

    if (!name && !plan) {
      return res.status(400).json({ error: 'Organization name or plan is required' });
    }
    if (plan && !plans.includes(plan)) {
      return res.status(400).json({ error: 'Unknown plan' });
    }
    if (plan === 'starter' || plan === 'business') {
      return res.status(400).json({ error: 'Subscribe to this plan through checkout' });
    }
    if (plan === 'enterprise') {
      return res.status(400).json({ error: 'Enterprise is available by request only. Contact support.' });
    }

    if (plan) {
      const member = await prisma.organizationMember.findFirst({
        where: { organizationId: req.organizationId, userId: req.userId },
      });
      if (member?.role !== 'owner' && member?.role !== 'admin') {
        return res.status(403).json({ error: 'Only an owner or admin can change the plan' });
      }
    }

    const updated = await prisma.organization.update({
      where: { id: req.organizationId },
      data: {
        ...(name ? { name } : {}),
        ...(plan ? { plan } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'ORGANIZATION_UPDATED',
        details: [
          name ? `Updated organization name to ${name}` : null,
          plan ? `Updated plan to ${plan}` : null,
        ].filter(Boolean).join('. '),
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true, organization: updated });
  } catch (error) {
    console.error('Update org error:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// Delete organization
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    const { confirmDelete } = req.body;

    if (confirmDelete !== 'DELETE') {
      return res.status(400).json({ error: 'You must type DELETE to confirm' });
    }

    const org = await prisma.organization.findUnique({
      where: { id: req.organizationId },
    });

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Check if user is owner
    const member = await prisma.organizationMember.findFirst({
      where: {
        organizationId: req.organizationId,
        userId: req.userId,
      },
    });

    if (member?.role !== 'owner') {
      return res.status(403).json({ error: 'Only owners can delete organization' });
    }

    // Cascade delete all related data
    await prisma.signatureRequest.deleteMany({ where: { organizationId: req.organizationId } });
    await prisma.approval.deleteMany({ where: { organizationId: req.organizationId } });

    await prisma.fileAccessLog.deleteMany({
      where: {
        file: { organizationId: req.organizationId },
      },
    });

    await prisma.fileAccessToken.deleteMany({
      where: {
        file: { organizationId: req.organizationId },
      },
    });

    await prisma.file.deleteMany({
      where: { organizationId: req.organizationId },
    });

    await prisma.matter.deleteMany({
      where: { organizationId: req.organizationId },
    });

    await prisma.auditLog.deleteMany({
      where: { organizationId: req.organizationId },
    });

    await prisma.organizationSettings.delete({
      where: { organizationId: req.organizationId },
    });

    await prisma.organizationMember.deleteMany({
      where: { organizationId: req.organizationId },
    });

    await prisma.organization.delete({
      where: { id: req.organizationId },
    });

    res.json({ success: true, message: 'Organization deleted' });
  } catch (error) {
    console.error('Delete org error:', error);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

export default router;
