#!/usr/bin/env node
// Signs Chytai's own Telegram account in once and puts its session into the site's Fly secrets (web/tgfeed.js
// reads the channels through it). Run on your own computer, in the repo, after `npm ci`:
//
//   node scripts/tg-login.js
//
// It asks for api_id and api_hash (my.telegram.org → API development tools), the account's phone number, the code
// Telegram sends to that account, and its cloud password if it has one. Then it runs
// `fly secrets set TG_API_ID=… TG_API_HASH=… TG_SESSION=… -a chytai-web` (or prints it, if you say no).
// The session is a key to the account: it goes only into Fly's secrets, never into the repo or a chat.
const readline = require("readline");
const { execFileSync } = require("child_process");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Logger, LogLevel } = require("telegram/extensions/Logger");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

(async () => {
  const apiId = +(process.env.TG_API_ID || (await ask("api_id: ")));
  const apiHash = process.env.TG_API_HASH || (await ask("api_hash: "));
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3, baseLogger: new Logger(LogLevel.ERROR), deviceModel: "Chytai", appVersion: "1.0" });
  await client.start({
    phoneNumber: () => ask("Номер акаунта (+380…): "),
    phoneCode: () => ask("Код, що прийшов у Telegram: "),
    password: () => ask("Хмарний пароль акаунта (якщо є): "),
    onError: (e) => console.log(`Помилка: ${e.message}`),
  });
  const me = await client.getMe();
  const session = client.session.save();
  await client.destroy().catch(() => {});
  console.log(`\nУвійшли як ${[me.firstName, me.lastName].filter(Boolean).join(" ")}${me.username ? ` (@${me.username})` : ""}.`);
  const args = ["secrets", "set", `TG_API_ID=${apiId}`, `TG_API_HASH=${apiHash}`, `TG_SESSION=${session}`, "-a", "chytai-web"];
  const yes = /^(y|т|так|yes)?$/i.test(await ask("Покласти в секрети Fly (chytai-web)? [Так/ні] "));
  rl.close();
  if (yes) {
    execFileSync("fly", args, { stdio: "inherit" });
    console.log("Готово. Сайт перезапуститься й за годину почне читати канали через цей акаунт.");
  } else console.log(`\nКоманда, щоб покласти самому:\nfly ${args.map((a) => (/[\s=]/.test(a) ? `'${a}'` : a)).join(" ")}`);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
