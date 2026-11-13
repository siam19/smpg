export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'AWAITING_VERIFICATION'
  | 'PAID'
  | 'COD_CONFIRMED'
  | 'PAYMENT_REJECTED'
  | 'CANCELLED';

export interface Order {
  id: string; // ORD-XXX
  customerName: string;
  customerPhone: string;
  items: Array<{ id: string; name: string; price: number; quantity: number }>;
  totalAmount: number; // BDT
  status: OrderStatus;
  smpgPaymentId?: string;
  paymentMethod?: 'bkash' | 'nagad' | 'cod';
  trxId?: string;
  retryUrl?: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory order storage for reference implementation
const orders = new Map<string, Order>();
const processedWebhookEvents = new Set<string>();

export const OrderStore = {
  create(orderData: Omit<Order, 'createdAt' | 'updatedAt' | 'status'>): Order {
    const now = new Date();
    const order: Order = {
      ...orderData,
      status: 'PENDING_PAYMENT',
      createdAt: now,
      updatedAt: now,
    };
    orders.set(order.id, order);
    return order;
  },

  get(id: string): Order | undefined {
    return orders.get(id);
  },

  update(id: string, updates: Partial<Order>): Order | undefined {
    const order = orders.get(id);
    if (!order) return undefined;

    const updated = {
      ...order,
      ...updates,
      updatedAt: new Date(),
    };
    orders.set(id, updated);
    return updated;
  },

  list(): Order[] {
    return Array.from(orders.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  },

  isEventProcessed(eventId: string): boolean {
    return processedWebhookEvents.has(eventId);
  },

  markEventProcessed(eventId: string): void {
    processedWebhookEvents.add(eventId);
  },

  reset(): void {
    orders.clear();
    processedWebhookEvents.clear();
  },
};
