import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { limitsFor } from '../plans';

const prisma = new PrismaClient();

function fileView(file: {
  id: string;
  name: string;
  size: bigint;
  mimeType: string;
  createdAt: Date;
  expiresAt: Date;
  downloadCount: number;
  matterId: string | null;
}) {
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size),
    mimeType: file.mimeType,
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
    downloadCount: file.downloadCount,
    matterId: file.matterId,
  };
}

export const mattersRouter = express.Router();

mattersRouter.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const [openMatters, pendingApprovals, documentsThisMonth] = await Promise.all([
      prisma.matter.count({ where: { organizationId: req.organizationId, status: 'open' } }),
      prisma.approval.count({ where: { organizationId: req.organizationId, status: 'pending' } }),
      prisma.file.count({ where: { organizationId: req.organizationId, createdAt: { gte: start } } }),
    ]);
    res.json({ openMatters, pendingApprovals, documentsThisMonth });
  } catch (error) {
    console.error('Matter summary error:', error);
    res.status(500).json({ error: 'Could not load matter summary' });
  }
});

mattersRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const matters = await prisma.matter.findMany({
      where: { organizationId: req.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { files: true, approvals: true } } },
    });
    res.json(
      matters.map((matter) => ({
        id: matter.id,
        name: matter.name,
        clientName: matter.clientName,
        status: matter.status,
        createdAt: matter.createdAt,
        fileCount: matter._count.files,
        approvalCount: matter._count.approvals,
      }))
    );
  } catch (error) {
    console.error('List matters error:', error);
    res.status(500).json({ error: 'Could not load matters' });
  }
});

mattersRouter.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    const clientName = String(req.body?.clientName || '').trim();
    if (!name || !clientName) {
      return res.status(400).json({ error: 'Matter name and client name are required' });
    }
    const organization = await prisma.organization.findUnique({
      where: { id: req.organizationId },
    });
    const limits = limitsFor(organization?.plan || 'solo');
    if (limits.openMatters !== null) {
      const open = await prisma.matter.count({
        where: { organizationId: req.organizationId, status: 'open' },
      });
      if (open >= limits.openMatters) {
        return res.status(403).json({
          error: 'Solo includes one open matter. Close it, or subscribe to Starter, before opening another. This matter is not deleted.',
        });
      }
    }
    const matter = await prisma.matter.create({
      data: {
        organizationId: req.organizationId!,
        name,
        clientName,
        createdById: req.userId!,
      },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'MATTER_OPENED',
        details: `Opened ${name} for ${clientName}`,
        ipAddress: req.ip || '',
      },
    });
    res.json(matter);
  } catch (error) {
    console.error('Create matter error:', error);
    res.status(500).json({ error: 'Could not open the matter' });
  }
});

mattersRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const matter = await prisma.matter.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
      include: { files: { orderBy: { createdAt: 'desc' } } },
    });
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    res.json({
      id: matter.id,
      name: matter.name,
      clientName: matter.clientName,
      status: matter.status,
      createdAt: matter.createdAt,
      files: matter.files.map(fileView),
    });
  } catch (error) {
    console.error('Get matter error:', error);
    res.status(500).json({ error: 'Could not load the matter' });
  }
});

mattersRouter.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.body?.status || '');
    if (status !== 'open' && status !== 'closed') {
      return res.status(400).json({ error: 'Status must be open or closed' });
    }
    const existing = await prisma.matter.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!existing) return res.status(404).json({ error: 'Matter not found' });
    const matter = await prisma.matter.update({ where: { id: existing.id }, data: { status } });
    res.json(matter);
  } catch (error) {
    console.error('Update matter error:', error);
    res.status(500).json({ error: 'Could not update the matter' });
  }
});

export const approvalsRouter = express.Router();

approvalsRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.approval.findMany({
      where: { organizationId: req.organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        matter: { select: { id: true, name: true } },
        file: { select: { id: true, name: true } },
      },
    });
    res.json(rows);
  } catch (error) {
    console.error('List approvals error:', error);
    res.status(500).json({ error: 'Could not load approvals' });
  }
});

approvalsRouter.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { matterId, fileId, note } = req.body || {};
    const file = await prisma.file.findFirst({
      where: { id: fileId, organizationId: req.organizationId, matterId },
    });
    if (!file) return res.status(404).json({ error: 'Document not found on this matter' });
    const approval = await prisma.approval.create({
      data: {
        organizationId: req.organizationId!,
        matterId,
        fileId,
        requestedById: req.userId!,
        note: note ? String(note) : null,
      },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        fileId,
        action: 'APPROVAL_REQUESTED',
        details: `Requested approval for ${file.name}`,
        ipAddress: req.ip || '',
      },
    });
    res.json(approval);
  } catch (error) {
    console.error('Create approval error:', error);
    res.status(500).json({ error: 'Could not request approval' });
  }
});

approvalsRouter.post('/:id/decision', async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.body?.status || '');
    if (status !== 'approved' && status !== 'rejected') {
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }
    const existing = await prisma.approval.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
      include: { file: { select: { name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Approval not found' });
    if (existing.status !== 'pending') {
      return res.status(400).json({ error: 'This approval is already decided' });
    }
    const approval = await prisma.approval.update({
      where: { id: existing.id },
      data: { status, decidedById: req.userId, decidedAt: new Date() },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        fileId: existing.fileId,
        action: status === 'approved' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
        details: `${status === 'approved' ? 'Approved' : 'Rejected'} ${existing.file.name}`,
        ipAddress: req.ip || '',
      },
    });
    res.json(approval);
  } catch (error) {
    console.error('Decide approval error:', error);
    res.status(500).json({ error: 'Could not record the decision' });
  }
});

export const signaturesRouter = express.Router();

signaturesRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.signatureRequest.findMany({
      where: { organizationId: req.organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        matter: { select: { id: true, name: true } },
        file: { select: { id: true, name: true } },
      },
    });
    res.json(rows);
  } catch (error) {
    console.error('List signatures error:', error);
    res.status(500).json({ error: 'Could not load signature requests' });
  }
});

signaturesRouter.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const signerName = String(req.body?.signerName || '').trim();
    const signerEmail = String(req.body?.signerEmail || '').trim();
    const { matterId, fileId } = req.body || {};
    if (!signerName || !signerEmail) {
      return res.status(400).json({ error: 'Signer name and email are required' });
    }
    const file = await prisma.file.findFirst({
      where: { id: fileId, organizationId: req.organizationId, matterId },
    });
    if (!file) return res.status(404).json({ error: 'Document not found on this matter' });
    const request = await prisma.signatureRequest.create({
      data: {
        organizationId: req.organizationId!,
        matterId,
        fileId,
        signerName,
        signerEmail,
      },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        fileId,
        action: 'SIGNATURE_REQUESTED',
        details: `Asked ${signerEmail} to accept ${file.name}`,
        ipAddress: req.ip || '',
      },
    });
    res.json(request);
  } catch (error) {
    console.error('Create signature error:', error);
    res.status(500).json({ error: 'Could not create the signature request' });
  }
});

export const signRouter = express.Router();

signRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const request = await prisma.signatureRequest.findUnique({
      where: { id: req.params.id },
      include: {
        file: { select: { name: true } },
        matter: { select: { name: true, clientName: true } },
        organization: { select: { name: true } },
      },
    });
    if (!request) return res.status(404).json({ error: 'Signature request not found' });
    res.json({
      id: request.id,
      status: request.status,
      signerName: request.signerName,
      signerEmail: request.signerEmail,
      documentName: request.file.name,
      matterName: request.matter.name,
      clientName: request.matter.clientName,
      organizationName: request.organization.name,
      signedName: request.signedName,
      signedAt: request.signedAt,
    });
  } catch (error) {
    console.error('Load signature error:', error);
    res.status(500).json({ error: 'Could not load the signature request' });
  }
});

signRouter.post('/:id', async (req: Request, res: Response) => {
  try {
    const signedName = String(req.body?.signedName || '').trim();
    if (signedName.length < 2) {
      return res.status(400).json({ error: 'Type your name to record acceptance' });
    }
    const existing = await prisma.signatureRequest.findUnique({
      where: { id: req.params.id },
      include: { file: { select: { name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Signature request not found' });
    if (existing.status !== 'pending') {
      return res.status(400).json({ error: 'This request is already complete' });
    }
    const updated = await prisma.signatureRequest.update({
      where: { id: existing.id },
      data: { status: 'signed', signedName, signedAt: new Date() },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: existing.organizationId,
        fileId: existing.fileId,
        action: 'SIGNATURE_RECORDED',
        details: `${signedName} accepted ${existing.file.name}`,
        ipAddress: req.ip || '',
      },
    });
    res.json({ success: true, status: updated.status, signedAt: updated.signedAt });
  } catch (error) {
    console.error('Record signature error:', error);
    res.status(500).json({ error: 'Could not record acceptance' });
  }
});
