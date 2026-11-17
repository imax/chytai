#!/usr/bin/env node
// Signs Chytai's own Telegram account in once and puts its session into the site's Fly secrets (web/tgfeed.js
// reads the channels through it). Run on your own computer, in the repo, after `npm ci --prefix web`:
//
//   node web/scripts/tg-login.js
//
// It asks for api_id and api_hash (my.telegram.org → API development tools), then shows a QR code: on the phone with
// that account, Telegram → Settings → Devices → «Link Desktop Device», scan it (a code by SMS/app never came to a
// new account on 2026-11-15; `--code` still signs in by phone number and code). Then the cloud password if it has one,
// and it runs
// `fly secrets set TG_API_ID=… TG_API_HASH=… TG_SESSION=… -a chytai-web` (or prints it, if you say no).
// The session is a key to the account: it goes only into Fly's secrets, never into the repo or a chat.
const readline = require("readline");
const { execFileSync } = require("child_process");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Logger, LogLevel } = require("telegram/extensions/Logger");

// A QR code in the terminal, black on white whatever the terminal's colours: one character = two rows of modules.
function qr(text) {
  const q = require("qrcode-generator")(0, "L");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const lines = [];
  for (let r = -pad; r < n + pad; r += 2) {
    let line = "";
    for (let c = -pad; c < n + pad; c++) line += `\x1b[${dark(r, c) ? 30 : 97}m\x1b[${dark(r + 1, c) ? 40 : 107}m▀`;
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

(async () => {
  const apiId = +(process.env.TG_API_ID || (await ask("api_id: ")));
  const apiHash = process.env.TG_API_HASH || (await ask("api_hash: "));
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3, baseLogger: new Logger(LogLevel.ERROR), deviceModel: "Chytai", appVersion: "1.0" });
  const onError = (e) => console.log(`Помилка: ${e.message}`);
  const password = () => ask("Хмарний пароль акаунта (якщо є): ");
  if (process.argv.includes("--code"))
    await client.start({ phoneNumber: () => ask("Номер акаунта (+380…): "), phoneCode: () => ask("Код, що прийшов у Telegram: "), password, onError });
  else {
    await client.connect();
    await client.signInUserWithQrCode({ apiId, apiHash }, {
      qrCode: async ({ token }) => {
        console.log("\nНа телефоні з цим акаунтом: Telegram → Налаштування → Пристрої → «Під'єднати пристрій», і наведіть на код.");
        console.log("(Код оновлюється щопів хвилини: скануйте найнижчий.)\n");
        console.log(qr(`tg://login?token=${Buffer.from(token).toString("base64url")}`));
      },
      password,
      onError,
    });
  }
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
