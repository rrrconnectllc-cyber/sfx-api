import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { limitsFor } from '../plans';

const router = express.Router();
const prisma = new PrismaClient();

// Get team members
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const members = await prisma.organizationMember.findMany({
      where: { organizationId: req.organizationId },
      include: {
        user: {
          select: { id: true, email: true, name: true, password: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    const formatted = members.map(m => ({
      id: m.id,
      name: m.user.name || m.user.email,
      email: m.user.email,
      role: m.role,
      joinedDate: formatDate(m.joinedAt),
      status: m.user.password ? 'active' : 'pending',
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// Invite team member
router.post('/invite', async (req: AuthRequest, res: Response) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const organization = await prisma.organization.findUnique({
      where: { id: req.organizationId },
    });
    const limits = limitsFor(organization?.plan || 'solo');
    if (limits.members !== null) {
      const count = await prisma.organizationMember.count({
        where: { organizationId: req.organizationId },
      });
      if (count >= limits.members) {
        const message = organization?.plan === 'solo'
          ? 'Solo includes one person. Subscribe to Starter to invite someone else. People already on the firm are not removed.'
          : `This plan includes ${limits.members} people. Remove someone or choose a larger plan before inviting.`;
        return res.status(403).json({ error: message });
      }
    }

    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { email },
    });

    // If user doesn't exist, create a placeholder account
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          password: '', // No password set yet; invite link resets it
          name: '',
        },
      });
    }

    // Check if already a member
    const existing = await prisma.organizationMember.findFirst({
      where: {
        userId: user.id,
        organizationId: req.organizationId,
      },
    });

    if (existing) {
      return res.status(400).json({ error: 'User already a member' });
    }

    // Create member invitation
    const member = await prisma.organizationMember.create({
      data: {
        userId: user.id,
        organizationId: req.organizationId!,
        role: role || 'member',
      },
      include: {
        user: { select: { email: true, name: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'USER_INVITED',
        details: `Invited ${email} as ${role}`,
        ipAddress: req.ip || '',
      },
    });

    res.json({
      success: true,
      message: `Invite sent to ${email}`,
      memberId: member.id,
    });
  } catch (error) {
    console.error('Invite error:', error);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// Update member role
router.patch('/:memberId', async (req: AuthRequest, res: Response) => {
  try {
    const { memberId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    const member = await prisma.organizationMember.findUnique({
      where: { id: memberId },
    });

    if (!member || member.organizationId !== req.organizationId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updated = await prisma.organizationMember.update({
      where: { id: memberId },
      data: { role },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'USER_ROLE_UPDATED',
        details: `Updated ${updated.user.email} to ${role}`,
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Remove team member
router.delete('/:memberId', async (req: AuthRequest, res: Response) => {
  try {
    const { memberId } = req.params;

    const member = await prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { email: true } } },
    });

    if (!member || member.organizationId !== req.organizationId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.organizationMember.delete({ where: { id: memberId } });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'USER_REMOVED',
        details: `Removed ${member.user.email}`,
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default router;
