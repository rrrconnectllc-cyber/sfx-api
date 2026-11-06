import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Accept invite and create member
router.post('/:memberId/accept', async (req: AuthRequest, res: Response) => {
  try {
    const { memberId } = req.params;

    // Find the pending member invitation
    const existingMember = await prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: true, organization: true },
    });

    if (!existingMember) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    if (!req.user?.email || req.user.email !== existingMember.user.email) {
      return res.status(403).json({ error: 'Sign in as the invited person to accept' });
    }

    const updated = await prisma.organizationMember.update({
      where: { id: memberId },
      data: { joinedAt: new Date() },
      include: { user: { select: { id: true, email: true, name: true } }, organization: true },
    });

    const token = jwt.sign(
      { userId: updated.user.id, organizationId: updated.organization.id, email: updated.user.email },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '30d' }
    );

    await prisma.auditLog.create({
      data: {
        organizationId: updated.organization.id,
        userId: updated.user.id,
        action: 'INVITATION_ACCEPTED',
        details: `Accepted invitation for ${updated.user.email}`,
        ipAddress: req.ip || '',
      },
    });

    res.json({
      success: true,
      token,
      user: { id: updated.user.id, email: updated.user.email, name: updated.user.name },
      organization: { id: updated.organization.id, name: updated.organization.name },
      member: {
        id: updated.id,
        email: updated.user.email,
        name: updated.user.name,
        role: updated.role,
        joinedAt: updated.joinedAt,
      },
    });
  } catch (error) {
    console.error('Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// Resend invite
router.post('/:memberId/resend-invite', async (req: AuthRequest, res: Response) => {
  try {
    const { memberId } = req.params;

    const member = await prisma.organizationMember.findUnique({
      where: { id: memberId },
    });

    if (!member || member.organizationId !== req.organizationId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // In production, send email here
    console.log(`Resending invite for member ${memberId}`);

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'INVITATION_RESENT',
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true, message: 'Invitation resent' });
  } catch (error) {
    console.error('Resend invite error:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

export default router;
