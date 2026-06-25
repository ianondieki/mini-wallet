import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { v4 as uuid } from 'uuid';
import api from '../lib/axios.js';
import { walletKeys } from './useWallet.js';

/**
 * M-Pesa hook: initiate an STK Push (top-up) and poll its status.
 */
export function useMpesa() {
  const qc = useQueryClient();

  const topupMutation = useMutation({
    mutationFn: async ({ amount, phone }) => {
      const { data } = await api.post('/api/mpesa/topup', { amount, phone });
      return data.data; // { checkoutRequestId, merchantRequestId, customerMessage }
    },
  });

  // B2C withdrawal. The wallet is debited synchronously (and reversed by the
  // backend if the B2C request fails); the payout itself settles asynchronously
  // via M-Pesa's result callback. A fresh idempotency key guards against
  // double-submits.
  const withdrawMutation = useMutation({
    mutationFn: async ({ amount, phone }) => {
      const { data } = await api.post(
        '/api/mpesa/withdraw',
        { amount, phone },
        { headers: { 'Idempotency-Key': uuid() } }
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: walletKeys.balance });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  return {
    topup: topupMutation.mutateAsync,
    topupMutation,
    withdraw: withdrawMutation.mutateAsync,
    withdrawMutation,
    qc,
  };
}

/**
 * Poll STK status every 3s until it settles (success/failed). On success the
 * wallet balance + transactions are invalidated so the UI refreshes.
 * @param {string|null} checkoutRequestId
 * @param {{onSettled?:(status:string)=>void}} [opts]
 */
export function useStkStatus(checkoutRequestId, { onSettled } = {}) {
  const qc = useQueryClient();

  return useQuery({
    queryKey: ['mpesa', 'status', checkoutRequestId],
    enabled: Boolean(checkoutRequestId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'success' || status === 'failed' ? false : 3000;
    },
    queryFn: async () => {
      const { data } = await api.get(`/api/mpesa/status/${checkoutRequestId}`);
      const result = data.data; // { status, amount, receipt }
      if (result.status === 'success') {
        qc.invalidateQueries({ queryKey: walletKeys.balance });
        qc.invalidateQueries({ queryKey: ['transactions'] });
      }
      if (result.status === 'success' || result.status === 'failed') {
        onSettled?.(result.status);
      }
      return result;
    },
  });
}

export default useMpesa;
