import { initializePaddle, type Paddle, type PaddleEventData } from '@paddle/paddle-js';

type Listener = (event: PaddleEventData) => void;

const listeners = new Set<Listener>();
let paddlePromise: Promise<Paddle> | null = null;

function getPaddle(): Promise<Paddle> {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN?.trim();
  if (!token) return Promise.reject(new Error('Web checkout is not configured yet.'));
  paddlePromise ??= initializePaddle({
    token,
    // Sandbox client-side tokens start with test_.
    environment: token.startsWith('test_') ? 'sandbox' : 'production',
    eventCallback: (event) => listeners.forEach((listener) => listener(event)),
  }).then((paddle) => {
    if (!paddle) throw new Error('Checkout could not load. Disable blockers and try again.');
    return paddle;
  }).catch((error: unknown) => {
    paddlePromise = null;
    throw error;
  });
  return paddlePromise;
}

/**
 * Opens Paddle's overlay for a server-created transaction. Resolves with the transaction id once paid,
 * or null when the parent closes checkout without paying.
 */
export async function openPaddleCheckout(transactionId: string, email?: string | null): Promise<string | null> {
  const paddle = await getPaddle();
  return new Promise((resolve) => {
    const listener: Listener = (event) => {
      if (event.name === 'checkout.completed') finish(event.data?.transaction_id ?? transactionId);
      else if (event.name === 'checkout.closed') finish(null);
    };
    const finish = (result: string | null) => {
      listeners.delete(listener);
      resolve(result);
    };
    listeners.add(listener);
    paddle.Checkout.open({
      transactionId,
      ...(email ? { customer: { email } } : {}),
      settings: { displayMode: 'overlay', theme: 'light', allowLogout: false },
    });
  });
}
