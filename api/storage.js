import { storage } from '../lib/handlers.js';
import { getStore } from '../lib/store.js';
export default async (req, res) => {
  try { return await storage(req, res, { env: process.env, store: await getStore() }); }
  catch (e) {
    console.error(e);
    res.statusCode = 500; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Could not read database storage usage.' }));
  }
};
