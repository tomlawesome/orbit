import webPush from "web-push";

const keys = webPush.generateVAPIDKeys();
process.stdout.write(`public=${keys.publicKey}\nprivate=${keys.privateKey}\n`);
