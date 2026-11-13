import { createStorefrontApp } from './app';

const app = createStorefrontApp();
const port = parseInt(process.env.PORT || '3000', 10);

console.log(`🛍️ SMPG Reference Storefront running at http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
