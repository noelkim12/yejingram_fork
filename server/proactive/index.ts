import express from 'express';
import i18next from 'i18next';
import webpush from 'web-push';
import 'dotenv/config';
import proactiveRouter from './routes.ts';
import { initI18n, startProactiveLoop } from './loop.ts';

await initI18n();

const pushPublicKey = process.env.push_public_key;
const pushPrivateKey = process.env.push_private_key;
if (!pushPublicKey || !pushPrivateKey || !process.env.SYNC_BASE_URL) {
    if (!pushPublicKey) {
        console.error(i18next.t('proactiveServer.missingEnv', { var: 'push_public_key' }));
    }
    if (!pushPrivateKey) {
        console.error(i18next.t('proactiveServer.missingEnv', { var: 'push_private_key' }));
    }
    if (!process.env.SYNC_BASE_URL) {
        console.error(i18next.t('proactiveServer.missingEnv', { var: 'SYNC_BASE_URL' }));
    }
    process.exit(1);
}

webpush.setVapidDetails(
    'https://github.com/YEJIN-DEV/yejingram',
    pushPublicKey,
    pushPrivateKey
);

const port = Number(process.env.HEADLESS_PORT ?? 39186);
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});
app.use('/api', proactiveRouter);

app.listen(port, () => {
    console.log(`[headless] Subscription API server (express) listening on port ${port}`);
});

startProactiveLoop({ syncBaseUrl: process.env.SYNC_BASE_URL });
