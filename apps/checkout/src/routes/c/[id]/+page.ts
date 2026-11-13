import type { PageLoad } from './$types';
import { fetchCheckoutData } from '../../../lib/api';

export const load: PageLoad = async ({ params, fetch }) => {
  const paymentId = params.id;
  try {
    const session = await fetchCheckoutData(paymentId, fetch);
    return {
      session,
      paymentId,
      error: null,
    };
  } catch (err: any) {
    return {
      session: null,
      paymentId,
      error: err.message || 'Payment not found',
    };
  }
};
