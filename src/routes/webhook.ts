import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const router = express.Router();
const prisma = new PrismaClient();

router.post('/billing', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!signature || !webhookSecret) {
      return res.status(400).json({ error: 'Webhook signature missing' });
    }

    // stripe.webhooks.constructEvent expects the raw body as string or buffer
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // Now raw body (Buffer), not parsed JSON
        signature,
        webhookSecret
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Handle different event types
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        const org = await prisma.organization.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (!org) {
          // Organization not found, skip logging
          break;
        }

        await prisma.auditLog.create({
          data: {
            organizationId: org.id,
            userId: null,
            action: 'PAYMENT_RECEIVED',
            details: `Invoice ${invoice.number} paid`,
            ipAddress: req.ip || '',
          },
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const org = await prisma.organization.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (org) {
          await prisma.organization.update({
            where: { id: org.id },
            data: { plan: 'solo', stripeSubscriptionId: null },
          });

          await prisma.auditLog.create({
            data: {
              organizationId: org.id,
              userId: null,
              action: 'PLAN_CANCELED',
              details: 'Subscription canceled by Stripe',
              ipAddress: req.ip || '',
            },
          });
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const customerId = charge.customer as string;

        if (customerId) {
          const org = await prisma.organization.findFirst({
            where: { stripeCustomerId: customerId },
          });

          if (org) {
            await prisma.auditLog.create({
              data: {
                organizationId: org.id,
                userId: null,
                action: 'REFUND_ISSUED',
                details: `Charge refunded: ${charge.amount / 100}`,
                ipAddress: req.ip || '',
              },
            });
          }
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
