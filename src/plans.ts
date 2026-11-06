export function limitsFor(plan: string): { members: number | null; openMatters: number | null } {
  if (plan === 'solo') return { members: 1, openMatters: 1 };
  if (plan === 'trial') return { members: null, openMatters: null };
  if (plan === 'starter') return { members: 3, openMatters: null };
  if (plan === 'business') return { members: 15, openMatters: null };
  return { members: null, openMatters: null };
}
