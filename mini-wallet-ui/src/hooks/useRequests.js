import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/axios.js';
import { walletKeys } from './useWallet.js';

export const requestKeys = { all: ['requests'] };

/**
 * Money requests and bill splits.
 *
 * Approving one moves money, so it invalidates the balance; creating or
 * declining one does not, but still refreshes the list because the other
 * party's view of the bill has changed.
 */
export function useRequests() {
  const qc = useQueryClient();

  const refreshList = () => qc.invalidateQueries({ queryKey: requestKeys.all });
  const refreshMoney = () => {
    refreshList();
    qc.invalidateQueries({ queryKey: walletKeys.balance });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };

  const listQuery = useQuery({
    queryKey: requestKeys.all,
    queryFn: async () => {
      const { data } = await api.get('/api/requests');
      return data.data; // { incoming, outgoing, youOwe, owedToYou }
    },
  });

  const create = useMutation({
    mutationFn: async (body) => {
      const { data } = await api.post('/api/requests', body);
      return data.data;
    },
    onSuccess: refreshList,
  });

  // No Idempotency-Key header: the settlement key is derived from the request
  // id on the server, so a double tap cannot double-pay regardless of what
  // the client sends.
  const approve = useMutation({
    mutationFn: async (requestId) => {
      const { data } = await api.post(`/api/requests/${requestId}/approve`);
      return data.data;
    },
    onSuccess: refreshMoney,
  });

  const decline = useMutation({
    mutationFn: async ({ requestId, reason }) => {
      const { data } = await api.post(`/api/requests/${requestId}/decline`, { reason });
      return data.data;
    },
    onSuccess: refreshList,
  });

  const cancel = useMutation({
    mutationFn: async ({ requestId, groupId }) => {
      const path = groupId ? `/api/requests/group/${groupId}` : `/api/requests/${requestId}`;
      const { data } = await api.delete(path);
      return data.data;
    },
    onSuccess: refreshList,
  });

  return {
    incoming: listQuery.data?.incoming ?? [],
    outgoing: listQuery.data?.outgoing ?? [],
    youOwe: Number(listQuery.data?.youOwe?.amount ?? 0),
    owedToYou: Number(listQuery.data?.owedToYou?.amount ?? 0),
    listQuery,
    create,
    approve,
    decline,
    cancel,
  };
}

export default useRequests;
