import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/axios.js';
import { walletKeys } from './useWallet.js';

export const savingsKeys = {
  goals: ['savings', 'goals'],
  quote: (goalId, amount) => ['savings', 'quote', goalId, amount],
};

/**
 * Savings goals.
 *
 * Every mutation invalidates the wallet balance as well as the goal list:
 * money moves between the two, and a stale spendable figure next to a fresh
 * vault figure is how a customer concludes their money has vanished.
 */
export function useSavings() {
  const qc = useQueryClient();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: savingsKeys.goals });
    qc.invalidateQueries({ queryKey: walletKeys.balance });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };

  const goalsQuery = useQuery({
    queryKey: savingsKeys.goals,
    queryFn: async () => {
      const { data } = await api.get('/api/savings/goals');
      return data.data; // { goals, totalSaved, spendable, currency }
    },
  });

  const createGoal = useMutation({
    mutationFn: async (body) => {
      const { data } = await api.post('/api/savings/goals', body);
      return data.data.goal;
    },
    onSuccess: refresh,
  });

  const contribute = useMutation({
    mutationFn: async ({ goalId, amount, idempotencyKey }) => {
      const { data } = await api.post(
        `/api/savings/goals/${goalId}/contribute`,
        { amount },
        { headers: { 'Idempotency-Key': idempotencyKey } }
      );
      return data.data;
    },
    onSuccess: refresh,
  });

  const withdraw = useMutation({
    mutationFn: async ({ goalId, amount, confirmPenalty, idempotencyKey }) => {
      const { data } = await api.post(
        `/api/savings/goals/${goalId}/withdraw`,
        { amount, confirmPenalty },
        { headers: { 'Idempotency-Key': idempotencyKey } }
      );
      return data.data;
    },
    onSuccess: refresh,
  });

  const closeGoal = useMutation({
    mutationFn: async (goalId) => {
      const { data } = await api.delete(`/api/savings/goals/${goalId}`);
      return data.data.goal;
    },
    onSuccess: refresh,
  });

  return {
    goals: goalsQuery.data?.goals ?? [],
    totalSaved: Number(goalsQuery.data?.totalSaved?.amount ?? 0),
    spendable: Number(goalsQuery.data?.spendable?.amount ?? 0),
    goalsQuery,
    createGoal,
    contribute,
    withdraw,
    closeGoal,
  };
}

/**
 * What breaking into a locked goal would cost, asked before the customer
 * commits. Server-side, so the figure shown is the figure charged — and the
 * withdrawal re-checks it, so a quote that goes stale is refused rather than
 * silently repriced.
 *
 * @param {string} goalId
 * @param {number} amount
 */
export function useWithdrawalQuote(goalId, amount) {
  return useQuery({
    queryKey: savingsKeys.quote(goalId, amount),
    enabled: Boolean(goalId) && Number(amount) > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const { data } = await api.get(`/api/savings/goals/${goalId}/withdrawal-quote`, {
        params: { amount },
      });
      return data.data;
    },
  });
}

export default useSavings;
