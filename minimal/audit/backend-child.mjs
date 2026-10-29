import { createApplication } from '../server/server.mjs';

let app;
try {
  const options = JSON.parse(process.argv[2]);
  app = await createApplication(options);
  process.send({ type: 'ready', url: app.url, token: app.token, pid: process.pid });
  process.on('message', async message => {
    if (message?.type !== 'close') return;
    await app.close();
    process.send({ type: 'stopped' }, () => process.disconnect());
  });
} catch (error) {
  process.send({ type: 'failed', code: error.code || 'START_FAILED' }, () => process.disconnect());
}
