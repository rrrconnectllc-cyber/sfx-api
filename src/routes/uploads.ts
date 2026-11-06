import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const prisma = new PrismaClient();
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

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

    const fileId = uuidv4();
    const encryptedPath = path.join(UPLOADS_DIR, fileId);

    // Save encrypted file to disk
    fs.writeFileSync(encryptedPath, Buffer.from(encryptedContent, 'base64'));

    // Create file record in database
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days default

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
        maxDownloads: 100,
        requirePassword: false,
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

    // Check if file is expired
    if (new Date() > file.expiresAt) {
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
    if (!fs.existsSync(file.encryptedPath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const fileContent = fs.readFileSync(file.encryptedPath);
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
