import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();
const prisma = new PrismaClient();

router.get('/:memberId', async (req: Request, res: Response) => {
  try {
    const member = await prisma.organizationMember.findUnique({
      where: { id: req.params.memberId },
      include: {
        user: { select: { email: true, password: true } },
        organization: { select: { name: true } },
      },
    });

    if (!member) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    res.json({
      memberId: member.id,
      email: member.user.email,
      role: member.role,
      organizationName: member.organization.name,
      status: member.user.password ? 'active' : 'pending',
    });
  } catch (error) {
    console.error('Invitation lookup error:', error);
    res.status(500).json({ error: 'Could not load the invitation' });
  }
});

router.post('/:memberId/accept', async (req: Request, res: Response) => {
  try {
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    const member = await prisma.organizationMember.findUnique({
      where: { id: req.params.memberId },
      include: { user: true, organization: true },
    });

    if (!member) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (!member.user.password) {
      if (password.length < 12) {
        return res.status(400).json({ error: 'Password must be at least 12 characters' });
      }
      await prisma.user.update({
        where: { id: member.user.id },
        data: {
          password: await bcrypt.hash(password, 10),
          name: name || member.user.email.split('@')[0],
        },
      });
    } else {
      const valid = await bcrypt.compare(password, member.user.password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    await prisma.organizationMember.update({
      where: { id: member.id },
      data: { joinedAt: new Date() },
    });

    const user = await prisma.user.findUnique({ where: { id: member.user.id } });
    const token = jwt.sign(
      { userId: member.user.id, organizationId: member.organizationId, email: member.user.email },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '30d' }
    );

    await prisma.auditLog.create({
      data: {
        organizationId: member.organizationId,
        userId: member.user.id,
        action: 'INVITATION_ACCEPTED',
        details: `Accepted invitation for ${member.user.email}`,
        ipAddress: req.ip || '',
      },
    });

    res.json({
      token,
      user: { id: user?.id, email: user?.email, name: user?.name },
      organization: { id: member.organization.id, name: member.organization.name },
    });
  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({ error: 'Could not accept the invitation' });
  }
});

export default router;
