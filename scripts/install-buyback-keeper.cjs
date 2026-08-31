const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parse } = require("dotenv");
const { getAddress, isAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const ROOT = process.env.ARCORIGIN_ROOT || "/opt/arcorigin-mainnet";
const SHARED_ENV = path.join(ROOT, "shared", ".env.production");
const KEEPER_ENV = path.join(ROOT, "shared", ".env.keeper");
const SYSTEMD_DIR = "/etc/systemd/system";
const SERVICE_NAME = "arcorigin-buyback-keeper.service";
const TIMER_NAME = "arcorigin-buyback-keeper.timer";

function runSystemctl(...args) {
  execFileSync("systemctl", args, { stdio: "inherit" });
}

function keeperPrivateKeyFromEnv(contents) {
  const values = parse(contents);
  const privateKey = values.BUYBACK_KEEPER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || "")) {
    throw new Error("Existing keeper environment contains an invalid private key.");
  }
  return privateKey;
}

function main() {
  if (process.getuid?.() !== 0) throw new Error("Keeper installation must run as root.");
  const productionValues = parse(fs.readFileSync(SHARED_ENV, "utf8"));
  const rpcUrl = productionValues.ARC_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("Active production environment has no ARC_MAINNET_RPC_URL.");
  const rpcFallbackUrls = productionValues.NEXT_PUBLIC_ARC_MAINNET_RPC_FALLBACK_URLS?.trim() || "";
  const configuredFactory = productionValues.NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS?.trim();
  if (!configuredFactory || !isAddress(configuredFactory)) {
    throw new Error("Active production environment has no valid mainnet Factory.");
  }
  const factory = getAddress(configuredFactory);

  const created = !fs.existsSync(KEEPER_ENV);
  const privateKey = created
    ? `0x${crypto.randomBytes(32).toString("hex")}`
    : keeperPrivateKeyFromEnv(fs.readFileSync(KEEPER_ENV, "utf8"));
  const account = privateKeyToAccount(privateKey);
  const keeperContents = [
    `BUYBACK_KEEPER_RPC_URL=${JSON.stringify(rpcUrl)}`,
    `BUYBACK_KEEPER_RPC_FALLBACK_URLS=${JSON.stringify(rpcFallbackUrls)}`,
    `BUYBACK_KEEPER_PRIVATE_KEY=${privateKey}`,
    `BUYBACK_KEEPER_FACTORY_ADDRESS=${factory}`,
    "",
  ].join("\n");
  const temporaryKeeperEnv = `${KEEPER_ENV}.next`;
  fs.writeFileSync(temporaryKeeperEnv, keeperContents, { flag: "wx", mode: 0o600 });
  fs.chownSync(temporaryKeeperEnv, 0, 0);
  fs.renameSync(temporaryKeeperEnv, KEEPER_ENV);

  for (const unitName of [SERVICE_NAME, TIMER_NAME]) {
    const source = path.join(ROOT, "current", "deploy", "systemd", unitName);
    const destination = path.join(SYSTEMD_DIR, unitName);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o644);
  }
  runSystemctl("daemon-reload");
  runSystemctl("enable", "--now", TIMER_NAME);
  runSystemctl("start", SERVICE_NAME);

  console.log(JSON.stringify({
    installed: true,
    created,
    keeper: account.address,
    factory,
    timer: TIMER_NAME,
    privateKeyPrinted: false,
  }, null, 2));
}

main();
