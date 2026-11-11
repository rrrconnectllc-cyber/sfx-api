import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ensureUploadsDir, storedFilePath, resolveStoredFile } from '../storage';

const router = express.Router();
const prisma = new PrismaClient();
ensureUploadsDir();

// Upload file
router.post('/upload', async (req: AuthRequest, res: Response) => {
  try {
    const { fileName, fileSize, encryptedContent, matterId } = req.body;

    if (!fileName || !fileSize || !encryptedContent) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (matterId) {
      const matter = await prisma.matter.findFirst({
        where: { id: matterId, organizationId: req.organizationId },
      });
      if (!matter) {
        return res.status(404).json({ error: 'Matter not found' });
      }
    }

    const prior = matterId
      ? await prisma.file.findFirst({
          where: { matterId, organizationId: req.organizationId, name: fileName },
          orderBy: { version: 'desc' },
        })
      : null;
    const version = prior ? prior.version + 1 : 1;

    const settings = await prisma.organizationSettings.findUnique({
      where: { organizationId: req.organizationId },
    });
    const expirationDays = Math.min(365, Math.max(1, settings?.defaultExpiration || 30));
    const downloadLimit = Math.max(1, settings?.maxDownloads || 100);

    const fileId = uuidv4();
    ensureUploadsDir();
    const encryptedPath = storedFilePath(fileId);

    fs.writeFileSync(encryptedPath, Buffer.from(encryptedContent, 'base64'));

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expirationDays);

    const file = await prisma.file.create({
      data: {
        id: fileId,
        organizationId: req.organizationId!,
        uploadedById: req.userId!,
        name: fileName,
        size: BigInt(fileSize),
        mimeType: 'application/octet-stream',
        encryptionKey: 'key-' + uuidv4(), // In production, use proper key management
        encryptedPath: encryptedPath,
        expiresAt,
        maxDownloads: downloadLimit,
        requirePassword: false,
        version,
        ...(matterId ? { matterId } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        fileId: file.id,
        action: 'FILE_UPLOADED',
        details: `Uploaded ${fileName} (${fileSize} bytes)`,
        ipAddress: req.ip || '',
      },
    });

    res.json({
      success: true,
      fileId: file.id,
      name: file.name,
      size: fileSize,
      expiresAt: file.expiresAt,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Download file
router.get('/download/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { fileId } = req.params;

    const file = await prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // CRITICAL: Verify file belongs to caller's organization
    if (file.organizationId !== req.organizationId) {
      return res.status(403).json({ error: 'You do not have access to this file' });
    }

    // Check if file is expired
    if (file.expiresAt && new Date() > file.expiresAt) {
      return res.status(410).json({ error: 'File has expired' });
    }

    // Check download limit
    if (file.downloadCount >= file.maxDownloads) {
      return res.status(429).json({ error: 'Download limit exceeded' });
    }

    // Log access
    await prisma.fileAccessLog.create({
      data: {
        fileId: file.id,
        accessedById: req.userId,
        ipAddress: req.ip || '',
        userAgent: req.get('user-agent') || '',
      },
    });

    // Increment download count
    await prisma.file.update({
      where: { id: fileId },
      data: { downloadCount: { increment: 1 } },
    });

    // Read and send file
    const filePath = resolveStoredFile(file.encryptedPath, file.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const fileContent = fs.readFileSync(filePath);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.setHeader('X-File-Id', file.id);
    res.setHeader('X-Encryption-Key', file.encryptionKey);

    res.send(fileContent);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
