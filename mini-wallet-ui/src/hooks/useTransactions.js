import { useQuery, keepPreviousData } from '@tanstack/react-query';
import api from '../lib/axios.js';

/**
 * Paginated transaction history. Filters: { page, limit, type, status }.
 * Empty string filters are omitted so they don't reach the API.
 * @param {object} filters
 */
export function useTransactions(filters = {}) {
  const { page = 1, limit = 10, type = '', status = '' } = filters;

  return useQuery({
    queryKey: ['transactions', { page, limit, type, status }],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = { page, limit };
      if (type) params.type = type;
      if (status) params.status = status;
      const { data } = await api.get('/api/wallet/transactions', { params });
      return data.data; // { transactions, pagination }
    },
  });
}

export default useTransactions;
