import { login } from '../lib/handlers.js';
export default (req, res) => login(req, res, { env: process.env });
