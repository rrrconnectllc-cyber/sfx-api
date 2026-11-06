import './env';
import express, { Request, Response, NextFunction } from 'express';
// @ts-ignore TS7016 — @types/cors is not installed in this package.
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import authRoutes from './routes/auth';
import filesRoutes from './routes/files';
import teamRoutes from './routes/team';
import dashboardRoutes from './routes/dashboard';
import settingsRoutes from './routes/settings';
import uploadsRoutes from './routes/uploads';
import membersRoutes from './routes/members';
import organizationsRoutes from './routes/organizations';
import billingRoutes from './routes/billing';
import invitationRoutes from './routes/invitations';
import { approvalsRouter, mattersRouter, signRouter, signaturesRouter } from './routes/legal';
import { authenticateToken } from './middleware/auth';

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 3001;

// Prisma returns file size as BigInt, which JSON.stringify rejects.
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? Number(value) : value
);

// Middleware
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://sfxlegal.org',
    'https://www.sfxlegal.org',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP',
});
app.use('/api/v1/', limiter);

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/invitations', invitationRoutes);
app.use('/api/v1/sign', signRouter);
app.use('/api/v1/files', authenticateToken, filesRoutes);
app.use('/api/v1/uploads', authenticateToken, uploadsRoutes);
app.use('/api/v1/team', authenticateToken, teamRoutes);
app.use('/api/v1/members', authenticateToken, membersRoutes);
app.use('/api/v1/organizations', authenticateToken, organizationsRoutes);
app.use('/api/v1/billing', authenticateToken, billingRoutes);
app.use('/api/v1/matters', authenticateToken, mattersRouter);
app.use('/api/v1/approvals', authenticateToken, approvalsRouter);
app.use('/api/v1/signatures', authenticateToken, signaturesRouter);
app.use('/api/v1/dashboard', authenticateToken, dashboardRoutes);
app.use('/api/v1/settings', authenticateToken, settingsRoutes);

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    status: err.status || 500,
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
const start = async () => {
  try {
    // Initialize database
    await prisma.$queryRaw`SELECT 1`;
    console.log('✓ Database connected');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n✓ API Server running on http://localhost:${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV}`);
      console.log(`✓ CORS enabled for localhost:3000\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});
