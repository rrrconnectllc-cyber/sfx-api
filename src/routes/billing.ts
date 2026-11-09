import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

const prices: Record<string, { monthly: number; yearly: number; name: string }> = {
  starter: { name: 'SFX Starter', monthly: 2900, yearly: 29900 },
  business: { name: 'SFX Business', monthly: 14900, yearly: 149900 },
};

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Stripe is not configured');
  }
  return new Stripe(key);
}

router.post('/checkout', async (req: AuthRequest, res: Response) => {
  const plan = String(req.body?.plan || '');
  const billingPeriod = req.body?.billingPeriod === 'yearly' ? 'yearly' : 'monthly';
  try {
    const priceData = prices[plan];
    if (!priceData) {
      return res.status(400).json({ error: 'Choose Starter or Business' });
    }

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: req.organizationId, userId: req.userId },
    });
    if (member?.role !== 'owner' && member?.role !== 'admin') {
      return res.status(403).json({ error: 'Only an owner or admin can subscribe' });
    }

    const amount = billingPeriod === 'yearly' ? priceData.yearly : priceData.monthly;
    const interval = billingPeriod === 'yearly' ? 'year' : 'month';

    const stripe = stripeClient();
    const baseUrl = process.env.FRONTEND_URL || 'https://sfxlegal.org';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: typeof req.user?.email === 'string' ? req.user.email : undefined,
      client_reference_id: req.organizationId,
      metadata: {
        organizationId: req.organizationId || '',
        plan,
        billingPeriod,
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amount,
            recurring: { interval },
            product_data: { name: `${priceData.name} (${billingPeriod === 'yearly' ? 'Yearly' : 'Monthly'})` },
          },
        },
      ],
      success_url: `${baseUrl}/dashboard/settings/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/dashboard/settings/billing`,
    });

    if (!session.url) {
      return res.status(500).json({ error: 'Checkout did not return a URL' });
    }

    res.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Checkout error:', { plan, organizationId: req.organizationId, error: message });
    if (message.includes('Stripe is not configured')) {
      return res.status(503).json({ error: 'Payment system is not available. Please try again later.' });
    }
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

router.post('/confirm', async (req: AuthRequest, res: Response) => {
  const sessionId = String(req.body?.sessionId || '');
  try {
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Missing checkout session' });
    }

    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.organizationId !== req.organizationId) {
      return res.status(403).json({ error: 'This checkout belongs to another organization' });
    }
    if (session.status !== 'complete') {
      return res.status(400).json({ error: 'Checkout is not complete' });
    }

    const plan = session.metadata?.plan;
    if (plan !== 'starter' && plan !== 'business') {
      return res.status(400).json({ error: 'Unknown plan' });
    }

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    await prisma.organization.update({
      where: { id: req.organizationId },
      data: {
        plan,
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId!,
        userId: req.userId,
        action: 'PLAN_UPDATED',
        details: `Subscribed to ${plan}`,
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true, plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Confirm checkout error:', { sessionId, organizationId: req.organizationId, error: message });
    res.status(500).json({ error: 'Could not confirm checkout' });
  }
});

router.post('/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: req.organizationId, userId: req.userId },
    });
    if (member?.role !== 'owner' && member?.role !== 'admin') {
      return res.status(403).json({ error: 'Only an owner or admin can change the plan' });
    }

    const organization = await prisma.organization.findUnique({
      where: { id: req.organizationId },
    });
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    if (organization.plan === 'solo') {
      return res.status(400).json({ error: 'This firm is already on Solo' });
    }
    if (organization.plan === 'enterprise') {
      return res.status(400).json({ error: 'Enterprise is arranged with us. Email hello@securefileexchange.com to change it.' });
    }

    const subscriptionIds = new Set<string>();
    if (organization.stripeSubscriptionId) subscriptionIds.add(organization.stripeSubscriptionId);
    if (organization.stripeCustomerId || organization.stripeSubscriptionId) {
      const stripe = stripeClient();
      if (organization.stripeCustomerId) {
        const listed = await stripe.subscriptions.list({
          customer: organization.stripeCustomerId,
          status: 'all',
          limit: 20,
        });
        for (const subscription of listed.data) {
          if (['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status)) {
            subscriptionIds.add(subscription.id);
          }
        }
      }
      for (const subscriptionId of subscriptionIds) {
        await stripe.subscriptions.cancel(subscriptionId);
      }
    }

    await prisma.organization.update({
      where: { id: organization.id },
      data: { plan: 'solo', stripeSubscriptionId: null },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: organization.id,
        userId: req.userId,
        action: 'PLAN_CANCELED',
        details: `Moved from ${organization.plan} to Solo`,
        ipAddress: req.ip || '',
      },
    });

    res.json({ success: true, plan: 'solo' });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Could not cancel the subscription. The plan was not changed.' });
  }
});

router.post('/webhook', async (req: express.Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!signature || !webhookSecret) {
      return res.status(400).json({ error: 'Webhook signature missing' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
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

        // Find org by customer ID and update payment status
        await prisma.auditLog.create({
          data: {
            organizationId: customerId, // We'll use customer ID temporarily
            userId: 'system',
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

        // Find org and revert to solo
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
              userId: 'system',
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
                userId: 'system',
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
