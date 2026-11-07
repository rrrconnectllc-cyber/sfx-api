import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

const prices: Record<string, { name: string; amount: number }> = {
  starter: { name: 'SFX Starter', amount: 2900 },
  business: { name: 'SFX Business', amount: 14900 },
};

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Stripe is not configured');
  }
  return new Stripe(key);
}

router.post('/checkout', async (req: AuthRequest, res: Response) => {
  try {
    const plan = String(req.body?.plan || '');
    const price = prices[plan];
    if (!price) {
      return res.status(400).json({ error: 'Choose Starter or Business' });
    }

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: req.organizationId, userId: req.userId },
    });
    if (member?.role !== 'owner' && member?.role !== 'admin') {
      return res.status(403).json({ error: 'Only an owner or admin can subscribe' });
    }

    const stripe = stripeClient();
    const baseUrl = process.env.FRONTEND_URL || 'https://sfxlegal.org';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: typeof req.user?.email === 'string' ? req.user.email : undefined,
      client_reference_id: req.organizationId,
      metadata: {
        organizationId: req.organizationId || '',
        plan,
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: price.amount,
            recurring: { interval: 'month' },
            product_data: { name: price.name },
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
  try {
    const sessionId = String(req.body?.sessionId || '');
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

export default router;
