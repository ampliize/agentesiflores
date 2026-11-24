// Entrypoint serverless da Vercel: todas as rotas passam pelo mesmo app Express.
import { createApp } from '../src/server/index.js';

export default createApp();
