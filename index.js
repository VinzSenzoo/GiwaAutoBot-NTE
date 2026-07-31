import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const GIWA_RPC_URL  = "https://sepolia-rpc.giwa.io";
const GIWA_CHAIN_ID = 91342;
const EXPLORER_URL  = "https://sepolia-explorer.giwa.io";
const EXPLORER_API  = "https://sepolia-explorer.giwa.io/api/v2";

const FAUCET_EXTENSION = "0x63CCe2b569A7bC35895ee24306c1512fefc06121";
const FAUCET_CLAIM     = "0xfe4b4F5f2f8843dC9Ca75E563f2f7eB0f44Ae83e";
const TEST_TOKEN       = "0xBCdB22f56642DE57624CfC2fBb9eE398cF3CA268";
const UP_ID_CONTRACT   = "0x091D00004f21eb2Fc30964A8a4995692d9b49628";
const DOJANG_SCROLL    = "0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9";
const ATTESTER_ID      = "0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678";
const EAS_CONTRACT     = "0x4200000000000000000000000000000000000021";

const ISSUE_FEE_ETH = "0.001";
const ISSUE_FEE_WEI = ethers.parseEther(ISSUE_FEE_ETH);
const TEST_DECIMALS = 18;
const CONFIG_FILE   = "config.json";
const isDebug       = false;

const FAUCET_EXTENSION_ABI = [
  "function payAndIssueEAS() payable returns (bytes32)",
  "function fee() view returns (uint256)",
  "function easExpirationDuration() view returns (uint64)",
  "function dojangScroll() view returns (address)",
  "function attesterId() view returns (bytes32)",
];

const FAUCET_CLAIM_ABI = [
  "function claim()",
  "function claimAmount() view returns (uint256)",
  "function claimInterval() view returns (uint256)",
  "function lastClaimedAt(address) view returns (uint256)",
  "function DOJANG_SCROLL() view returns (address)",
  "function ATTESTER_ID() view returns (bytes32)",
  "function TOKEN() view returns (address)",
];

const DOJANG_SCROLL_ABI = [
  "function isVerified(address addr, bytes32 attesterId) view returns (bool)",
  "function getVerifiedAddressAttestationUid(address addr, bytes32 attesterId) view returns (bytes32)",
];

const EAS_ABI = [
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const UP_ID_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event NameRegistered(string name, address indexed owner)",
  "event NameRevoked(string name)",
];

const RANDOM_UPID_BLOCK_RANGE = 5000;
const RANDOM_UPID_CACHE_MS     = 60_000;

let walletInfo = {
  address: "N/A",
  balanceETH: "0.000000",
  balanceTEST: "0.000000",
  upId: "N/A",
};

let transactionLogs       = [];
let activityRunning       = false;
let isCycleRunning        = false;
let shouldStop            = false;
let dailyActivityInterval = null;
let accounts              = [];
let proxies               = [];
let upidTargets           = [];
let selectedWalletIndex   = 0;
let loadingSpinner        = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const borderBlinkColors   = ["cyan","blue","magenta","red","yellow","green"];
let borderBlinkIndex      = 0;
let spinnerIndex          = 0;
let nonceTracker          = {};
let hasLoggedSleepInterrupt = false;
let activeProcesses       = 0;
const upIdNameCache       = {};
let randomUpIdCache       = { names: [], fetchedAt: 0 };

let dailyActivityConfig = {
  issueDojangEnabled: true,
  claimFaucetEnabled: true,
  sendEnabled:        true,
  randomUpIdEnabled:  false,
  sendRepetitions:    1,
  sendAmountMin:      0.01,
  sendAmountMax:      0.05,
  loopHours:          24,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      dailyActivityConfig.issueDojangEnabled = cfg.issueDojangEnabled !== undefined ? Boolean(cfg.issueDojangEnabled) : true;
      dailyActivityConfig.claimFaucetEnabled = cfg.claimFaucetEnabled !== undefined ? Boolean(cfg.claimFaucetEnabled) : true;
      dailyActivityConfig.sendEnabled        = cfg.sendEnabled        !== undefined ? Boolean(cfg.sendEnabled)        : true;
      dailyActivityConfig.randomUpIdEnabled  = cfg.randomUpIdEnabled  !== undefined ? Boolean(cfg.randomUpIdEnabled)  : false;
      dailyActivityConfig.sendRepetitions    = Number(cfg.sendRepetitions) || 1;
      dailyActivityConfig.sendAmountMin      = Number(cfg.sendAmountMin)   || 0.01;
      dailyActivityConfig.sendAmountMax      = Number(cfg.sendAmountMax)   || 0.05;
      dailyActivityConfig.loopHours          = Number(cfg.loopHours)       || 24;
      addLog("Config loaded from config.json", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason?.message || reason}`, "error");
});
process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortHash(hash) {
  return hash ? hash.slice(0, 6) + "..." + hash.slice(-4) : "N/A";
}

function getRandomAmount(min, max) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(4));
}

function isRetryableNetworkError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("socket hang up") || msg.includes("econnreset") ||
    msg.includes("etimedout")       || msg.includes("fetch failed") ||
    msg.includes("timeout")         || msg.includes("502") || msg.includes("504") ||
    msg.includes("network")         || msg.includes("econnrefused")
  );
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function normalizeUpIdName(raw) {
  if (!raw) return "";
  let name = String(raw).trim().toLowerCase();
  if (name.endsWith(".up.id")) name = name.slice(0, -6);
  return name;
}

function upIdTokenId(name) {
  return BigInt(ethers.keccak256(ethers.toUtf8Bytes(normalizeUpIdName(name))));
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":   coloredMessage = chalk.redBright(message);     break;
    case "success": coloredMessage = chalk.greenBright(message);   break;
    case "warn":    coloredMessage = chalk.magentaBright(message); break;
    case "wait":    coloredMessage = chalk.yellowBright(message);  break;
    case "info":    coloredMessage = chalk.whiteBright(message);   break;
    case "delay":   coloredMessage = chalk.cyanBright(message);    break;
    case "debug":   coloredMessage = chalk.blueBright(message);    break;
    default:        coloredMessage = chalk.white(message);
  }
  transactionLogs.push(`[${timestamp}] ${coloredMessage}`);
  updateLogs();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent("");
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    accounts = data.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(pk => {
      const key = pk.startsWith("0x") ? pk : `0x${pk}`;
      return { privateKey: key };
    });
    if (accounts.length === 0) throw new Error("No private keys found in pk.txt");
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(p => p.trim()).filter(p => p && !p.startsWith("#"));
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function loadUpIdTargets() {
  try {
    if (fs.existsSync("upid.txt")) {
      const data = fs.readFileSync("upid.txt", "utf8");
      upidTargets = data
        .split("\n")
        .map(l => normalizeUpIdName(l))
        .filter(l => l && !l.startsWith("#"));
      addLog(`Loaded ${upidTargets.length} UP ID targets from upid.txt`, "success");
    } else {
      upidTargets = [];
      if (!dailyActivityConfig.randomUpIdEnabled) {
        addLog("No upid.txt found. Auto Send will be skipped (or enable Random UP ID).", "warn");
      } else {
        addLog("No upid.txt found. Random UP ID mode will use on-chain names.", "info");
      }
    }
  } catch (error) {
    addLog(`Failed to load upid.txt: ${error.message}`, "warn");
    upidTargets = [];
  }
}

/**
 * Fetch active registered UP IDs from the last N blocks.
 * Same approach as GIWA Playground "Registered UP IDs" (NameRegistered / NameRevoked, last 5000 blocks).
 * Returns unique names that are still registered (latest event is not revoke), newest first.
 */
async function fetchRecentUpIdsFromBlocks(provider, blockRange = RANDOM_UPID_BLOCK_RANGE) {
  const upid = new ethers.Contract(UP_ID_CONTRACT, UP_ID_ABI, provider);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - blockRange);

  const [registered, revoked] = await Promise.all([
    upid.queryFilter(upid.filters.NameRegistered(), fromBlock, latest),
    upid.queryFilter(upid.filters.NameRevoked(), fromBlock, latest),
  ]);

  const events = [
    ...registered.map((e) => ({
      name: normalizeUpIdName(e.args?.name ?? e.args?.[0]),
      kind: "register",
      blockNumber: Number(e.blockNumber),
      logIndex: Number(e.index ?? e.logIndex ?? 0),
    })),
    ...revoked.map((e) => ({
      name: normalizeUpIdName(e.args?.name ?? e.args?.[0]),
      kind: "revoke",
      blockNumber: Number(e.blockNumber),
      logIndex: Number(e.index ?? e.logIndex ?? 0),
    })),
  ].filter((e) => e.name);

  events.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber
  );

  const latestKind = new Map();
  for (const e of events) latestKind.set(e.name, e.kind);

  const seen = new Set();
  const names = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const n = events[i].name;
    if (seen.has(n)) continue;
    seen.add(n);
    if (latestKind.get(n) === "register") names.push(n);
  }

  return { names, latest, fromBlock, registeredCount: registered.length, revokedCount: revoked.length };
}

async function getRandomUpIdTarget(provider, excludeName = null) {
  const now = Date.now();
  const cacheFresh =
    randomUpIdCache.names.length > 0 &&
    now - randomUpIdCache.fetchedAt < RANDOM_UPID_CACHE_MS;

  if (!cacheFresh) {
    addLog(
      `[Random UP ID] Scanning last ${RANDOM_UPID_BLOCK_RANGE} blocks for registered names...`,
      "wait"
    );
    const result = await withRetry(
      () => fetchRecentUpIdsFromBlocks(provider),
      "Fetch Random UP ID"
    );
    randomUpIdCache = { names: result.names, fetchedAt: now };
    addLog(
      `[Random UP ID] Found ${result.names.length} active names (blocks ${result.fromBlock}–${result.latest}, reg=${result.registeredCount}, rev=${result.revokedCount})`,
      "success"
    );
  }

  let pool = randomUpIdCache.names;
  if (excludeName) {
    const ex = normalizeUpIdName(excludeName);
    pool = pool.filter((n) => n !== ex);
  }
  if (pool.length === 0) {
    throw new Error(
      `No active UP IDs found in last ${RANDOM_UPID_BLOCK_RANGE} blocks. Try again later or use upid.txt.`
    );
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  return proxyUrl.startsWith("socks")
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);
}

function getProvider(proxyUrl) {
  const agent = createAgent(proxyUrl);
  const fetchOptions = agent ? { agent } : {};
  return new ethers.JsonRpcProvider(
    GIWA_RPC_URL,
    { chainId: GIWA_CHAIN_ID, name: "GiwaSepolia" },
    { fetchOptions }
  );
}

async function sleep(ms) {
  if (shouldStop) return;
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (shouldStop) { clearTimeout(timeout); clearInterval(check); resolve(); }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function withRetry(operation, taskName = "RPC Call", maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    if (shouldStop) throw new Error("Process stopped");
    try {
      return await operation();
    } catch (error) {
      attempt++;
      if (isRetryableNetworkError(error)) {
        addLog(`[${taskName}] Network error, retry ${attempt}/${maxRetries}...`, "warn");
        if (attempt >= maxRetries) throw error;
        await sleep(2000 * attempt);
      } else {
        throw error;
      }
    }
  }
}

async function getFeeParams(provider) {
  try {
    const feeData = await provider.getFeeData();
    const bump = 120n;
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      return {
        maxFeePerGas:         (feeData.maxFeePerGas * bump) / 100n,
        maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * bump) / 100n,
      };
    }
    if (feeData.gasPrice) {
      return { gasPrice: (feeData.gasPrice * bump) / 100n };
    }
    return {};
  } catch {
    return {};
  }
}

async function getNextNonce(provider, walletAddress) {
  if (shouldStop) throw new Error("Process stopped");
  const key         = `${GIWA_CHAIN_ID}_${walletAddress.toLowerCase()}`;
  const pending     = BigInt(await provider.getTransactionCount(walletAddress, "pending"));
  const lastUsed    = nonceTracker[key] !== undefined ? nonceTracker[key] : pending - 1n;
  const next        = pending > lastUsed + 1n ? pending : lastUsed + 1n;
  nonceTracker[key] = next;
  return next;
}

async function waitForTx(provider, txHash, timeoutMs = 180000, pollMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let netErrCount = 0;
  while (Date.now() < deadline) {
    if (shouldStop) throw new Error("Process stopped");
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 0) throw new Error("Transaction reverted on-chain");
        return receipt;
      }
      await sleep(pollMs);
    } catch (error) {
      if (String(error.message || "").includes("reverted")) throw error;
      if (!isRetryableNetworkError(error)) throw error;
      netErrCount++;
      if (netErrCount >= 15) throw new Error("RPC timeout waiting for transaction");
      await sleep(pollMs + 2000 * netErrCount);
    }
  }
  throw new Error("Transaction confirmation timed out");
}

async function getDojangStatus(provider, walletAddress) {
  const scroll = new ethers.Contract(DOJANG_SCROLL, DOJANG_SCROLL_ABI, provider);
  let verified = false;
  let uid = ethers.ZeroHash;
  let expirationTime = 0n;
  let revocationTime = 0n;

  try {
    verified = await scroll.isVerified(walletAddress, ATTESTER_ID);
  } catch (e) {
    addLog(`[Dojang] isVerified check failed: ${e.message}`, "warn");
  }

  try {
    uid = await scroll.getVerifiedAddressAttestationUid(walletAddress, ATTESTER_ID);
    if (uid && uid !== ethers.ZeroHash) {
      const eas = new ethers.Contract(EAS_CONTRACT, EAS_ABI, provider);
      const att = await eas.getAttestation(uid);
      expirationTime = BigInt(att.expirationTime);
      revocationTime = BigInt(att.revocationTime);
    }
  } catch (e) {
    addLog(`[Dojang] Attestation detail warning: ${e.message}`, "debug");
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const expired = expirationTime > 0n && now >= expirationTime;
  const revoked = revocationTime > 0n;
  const active  = verified && !expired && !revoked && uid !== ethers.ZeroHash;

  return { verified, active, expired, revoked, uid, expirationTime, revocationTime };
}

async function getClaimStatus(provider, walletAddress) {
  const faucet = new ethers.Contract(FAUCET_CLAIM, FAUCET_CLAIM_ABI, provider);
  const [lastClaimedAt, claimInterval, claimAmount] = await Promise.all([
    faucet.lastClaimedAt(walletAddress),
    faucet.claimInterval(),
    faucet.claimAmount(),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const last = BigInt(lastClaimedAt);
  const interval = BigInt(claimInterval);
  const nextClaimAt = last + interval;
  const canClaim = last === 0n || now >= nextClaimAt;
  const remaining = canClaim ? 0n : nextClaimAt - now;
  return {
    lastClaimedAt: last,
    claimInterval: interval,
    claimAmount: BigInt(claimAmount),
    canClaim,
    remaining,
    nextClaimAt,
  };
}

async function resolveUpId(provider, name) {
  const clean = normalizeUpIdName(name);
  if (!clean) throw new Error("Empty UP ID name");
  const tokenId = upIdTokenId(clean);
  const upid = new ethers.Contract(UP_ID_CONTRACT, UP_ID_ABI, provider);
  const owner = await upid.ownerOf(tokenId);
  if (!owner || owner === ethers.ZeroAddress) {
    throw new Error(`UP ID "${clean}" not found / unregistered`);
  }
  return { name: clean, fullName: `${clean}.up.id`, address: owner, tokenId };
}

async function getOwnedUpIdName(walletAddress, proxyUrl = null) {
  const key = walletAddress.toLowerCase();
  if (upIdNameCache[key] !== undefined) return upIdNameCache[key];

  try {
    const agent = createAgent(proxyUrl);
    const url = `${EXPLORER_API}/addresses/${walletAddress}/nft?type=ERC-721`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      ...(agent ? { agent } : {}),
    });
    if (!res.ok) {
      upIdNameCache[key] = "-";
      return "-";
    }
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const match = items.find((item) => {
      const tokenAddr = (item?.token?.address_hash || item?.token?.address || "").toLowerCase();
      return tokenAddr === UP_ID_CONTRACT.toLowerCase();
    });

    if (!match) {
      upIdNameCache[key] = "-";
      return "-";
    }

    let name =
      match?.metadata?.name ||
      match?.metadata?.description ||
      "";
    if (typeof name === "string" && name.includes(",")) {
      name = name.split(",")[0].trim();
    }
    name = normalizeUpIdName(name);
    const display = name || "-";
    upIdNameCache[key] = display;
    return display;
  } catch {
    upIdNameCache[key] = "-";
    return "-";
  }
}

async function updateWalletData() {
  const results = await Promise.allSettled(
    accounts.map(async (account, i) => {
      try {
        const proxyUrl = proxies.length ? proxies[i % proxies.length] : null;
        const provider = getProvider(proxyUrl);
        const wallet   = new ethers.Wallet(account.privateKey);
        const token    = new ethers.Contract(TEST_TOKEN, ERC20_ABI, provider);

        const [ethBal, testBal, upName] = await Promise.all([
          provider.getBalance(wallet.address),
          token.balanceOf(wallet.address).catch(() => 0n),
          getOwnedUpIdName(wallet.address, proxyUrl),
        ]);

        const ethStr  = parseFloat(ethers.formatEther(ethBal)).toFixed(4);
        const testStr = parseFloat(ethers.formatUnits(testBal, TEST_DECIMALS)).toFixed(4);
        const upStr   = upName && upName !== "-" ? upName : "-";

        if (i === selectedWalletIndex) {
          walletInfo.address     = wallet.address;
          walletInfo.balanceETH  = ethStr;
          walletInfo.balanceTEST = testStr;
          walletInfo.upId        = upStr;
        }

        const prefix = i === selectedWalletIndex ? "➯ " : "  ";
        const paddedAddress = (prefix + getShortAddress(wallet.address)).padEnd(16);
        const upDisplay = upStr.length > 14 ? upStr.slice(0, 12) + ".." : upStr;
        return (
          `${chalk.bold.magentaBright(paddedAddress)}` +
          `  ${chalk.bold.cyanBright(ethStr.padEnd(10))}` +
          `  ${chalk.bold.yellowBright(testStr.padEnd(10))}` +
          `  ${chalk.bold.greenBright(upDisplay)}`
        );
      } catch {
        return `  Error loading wallet ${i + 1}`;
      }
    })
  );
  return results.map(r => (r.status === "fulfilled" ? r.value : "  Error"));
}

async function performIssueDojang(wallet, provider) {
  addLog(`[Dojang] Checking attestation status for ${getShortAddress(wallet.address)}...`, "wait");

  const status = await getDojangStatus(provider, wallet.address);

  if (status.active) {
    const expStr = status.expirationTime > 0n
      ? new Date(Number(status.expirationTime) * 1000).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
      : "N/A";
    addLog(`[Dojang] Already verified (active). Exp: ${expStr}`, "success");
    addLog(`[Dojang] Skip Issue Dojang ➯ still valid.`, "info");
    return { skipped: true, reason: "already_verified" };
  }

  if (status.expired) {
    addLog(`[Dojang] Previous attestation EXPIRED. Will re-issue...`, "warn");
  } else if (status.revoked) {
    addLog(`[Dojang] Previous attestation REVOKED. Will re-issue...`, "warn");
  } else {
    addLog(`[Dojang] No active attestation found. Issuing new Dojang...`, "info");
  }

  const ethBal = await provider.getBalance(wallet.address);
  if (ethBal < ISSUE_FEE_WEI) {
    throw new Error(`Insufficient ETH for fee. Need ${ISSUE_FEE_ETH} ETH, have ${ethers.formatEther(ethBal)}`);
  }

  const ext = new ethers.Contract(FAUCET_EXTENSION, FAUCET_EXTENSION_ABI, wallet.connect(provider));
  let feeOnChain = ISSUE_FEE_WEI;
  try {
    feeOnChain = await ext.fee();
  } catch {
    feeOnChain = ISSUE_FEE_WEI;
  }

  addLog(`[Dojang] Calling payAndIssueEAS() with ${ethers.formatEther(feeOnChain)} ETH...`, "wait");
  const feeParams = await getFeeParams(provider);
  const nonce     = await getNextNonce(provider, wallet.address);

  const tx = await withRetry(() =>
    ext.payAndIssueEAS({
      value: feeOnChain,
      gasLimit: 400000n,
      nonce,
      ...feeParams,
    }), "Issue Dojang"
  );

  addLog(`[Dojang] Tx sent: ${getShortHash(tx.hash)}`, "warn");
  addLog(`[Dojang] Explorer: ${EXPLORER_URL}/tx/${tx.hash}`, "debug");
  const receipt = await waitForTx(provider, tx.hash);
  addLog(`[Dojang] Issue Dojang SUCCESS! Hash: ${getShortHash(tx.hash)} | Gas: ${receipt.gasUsed.toString()}`, "success");

  await sleep(2000);
  const after = await getDojangStatus(provider, wallet.address);
  if (after.active) {
    addLog(`[Dojang] Verification confirmed active on-chain.`, "success");
  } else {
    addLog(`[Dojang] Tx ok but isVerified still false (may need a short delay).`, "warn");
  }

  return { skipped: false, hash: tx.hash, receipt };
}

async function performClaimFaucet(wallet, provider) {
  addLog(`[Faucet] Checking claim eligibility...`, "wait");

  const doj = await getDojangStatus(provider, wallet.address);
  if (!doj.active) {
    throw new Error("Not verified on Dojang. Issue Dojang first before claiming faucet.");
  }

  const claim = await getClaimStatus(provider, wallet.address);
  const amountFmt = ethers.formatUnits(claim.claimAmount, TEST_DECIMALS);

  if (!claim.canClaim) {
    const nextAt = new Date(Number(claim.nextClaimAt) * 1000).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    addLog(`[Faucet] Already claimed. Cooldown remaining: ${formatDuration(claim.remaining)}`, "warn");
    addLog(`[Faucet] Next claim available at: ${nextAt}`, "info");
    return { skipped: true, reason: "cooldown", remaining: claim.remaining };
  }

  addLog(`[Faucet] Eligible to claim ${amountFmt} TEST. Sending claim()...`, "wait");

  const faucet = new ethers.Contract(FAUCET_CLAIM, FAUCET_CLAIM_ABI, wallet.connect(provider));
  const feeParams = await getFeeParams(provider);
  const nonce     = await getNextNonce(provider, wallet.address);

  const tx = await withRetry(() =>
    faucet.claim({
      gasLimit: 200000n,
      nonce,
      ...feeParams,
    }), "Claim Faucet"
  );

  addLog(`[Faucet] Tx sent: ${getShortHash(tx.hash)}`, "warn");
  const receipt = await waitForTx(provider, tx.hash);
  addLog(`[Faucet] Claim SUCCESS! +${amountFmt} TEST | Hash: ${getShortHash(tx.hash)}`, "success");
  return { skipped: false, hash: tx.hash, receipt, amount: amountFmt };
}

async function performSendTest(wallet, provider, targetName, amount) {
  const label = "Send";
  addLog(`[${label}] Resolving UP ID: ${targetName}...`, "wait");

  const resolved = await resolveUpId(provider, targetName);
  addLog(`[${label}] ${resolved.fullName} ➯ ${getShortAddress(resolved.address)}`, "success");

  if (resolved.address.toLowerCase() === wallet.address.toLowerCase()) {
    addLog(`[${label}] Target is self wallet, skipping.`, "warn");
    return { skipped: true, reason: "self" };
  }

  const token = new ethers.Contract(TEST_TOKEN, ERC20_ABI, wallet.connect(provider));
  const amountWei = ethers.parseUnits(amount.toFixed(4), TEST_DECIMALS);

  const bal = await token.balanceOf(wallet.address);
  if (bal < amountWei) {
    throw new Error(`Insufficient TEST. Need ${amount}, have ${ethers.formatUnits(bal, TEST_DECIMALS)}`);
  }

  addLog(`[${label}] Sending ${amount} TEST ➯ ${resolved.fullName} (${getShortAddress(resolved.address)})...`, "wait");

  const feeParams = await getFeeParams(provider);
  const nonce     = await getNextNonce(provider, wallet.address);

  const tx = await withRetry(() =>
    token.transfer(resolved.address, amountWei, {
      gasLimit: 250000n,
      nonce,
      ...feeParams,
    }), "Send TEST"
  );

  addLog(`[${label}] Tx sent: ${getShortHash(tx.hash)}`, "warn");
  const receipt = await waitForTx(provider, tx.hash);
  addLog(`[${label}] Send SUCCESS! ${amount} TEST ➯ ${resolved.fullName} | Hash: ${getShortHash(tx.hash)}`, "success");
  return { skipped: false, hash: tx.hash, receipt, to: resolved.address, name: resolved.fullName, amount };
}

async function runDailyActivity() {
  if (activityRunning) {
    addLog("Activity is already running.", "warn");
    return;
  }
  if (accounts.length === 0) {
    addLog("No accounts loaded. Add private keys to pk.txt.", "error");
    return;
  }

  activityRunning         = true;
  isCycleRunning          = true;
  shouldStop              = false;
  hasLoggedSleepInterrupt = false;
  nonceTracker            = {};
  updateMenu();
  updateStatus();

  try {
    addLog(`━━━ GIWA Playground Auto Daily Bot Started (${accounts.length} accounts) ━━━`, "info");

    for (let i = 0; i < accounts.length && !shouldStop; i++) {
      const proxyUrl = proxies.length ? proxies[i % proxies.length] : null;
      const wallet   = new ethers.Wallet(accounts[i].privateKey);
      const provider = getProvider(proxyUrl);

      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet for account ${i + 1}`, "error");
        continue;
      }

      addLog(`━━━ Account ${i + 1}/${accounts.length}: ${getShortAddress(wallet.address)} ━━━`, "info");
      addLog(`Using Proxy: ${proxyUrl || "none"}`, "info");

      if (dailyActivityConfig.issueDojangEnabled && !shouldStop) {
        addLog(`Account ${i + 1} - Starting Auto Issue Dojang`, "info");
        try {
          await performIssueDojang(wallet, provider);
        } catch (e) {
          addLog(`Account ${i + 1} - Issue Dojang failed: ${e.message}`, "error");
          delete nonceTracker[`${GIWA_CHAIN_ID}_${wallet.address.toLowerCase()}`];
        } finally {
          await updateWallets();
        }
      } else {
        addLog(`Account ${i + 1} - Auto Issue Dojang disabled, skipping.`, "info");
      }

      if (shouldStop) break;

      if (dailyActivityConfig.claimFaucetEnabled) {
        const d = Math.floor(Math.random() * (12000 - 6000 + 1)) + 6000;
        addLog(`Waiting ${Math.floor(d / 1000)}s before Auto Claim Faucet...`, "delay");
        await sleep(d);
      }

      if (dailyActivityConfig.claimFaucetEnabled && !shouldStop) {
        addLog(`Account ${i + 1} - Starting Auto Claim Faucet`, "info");
        try {
          await performClaimFaucet(wallet, provider);
        } catch (e) {
          addLog(`Account ${i + 1} - Claim Faucet failed: ${e.message}`, "error");
          delete nonceTracker[`${GIWA_CHAIN_ID}_${wallet.address.toLowerCase()}`];
        } finally {
          await updateWallets();
        }
      } else {
        addLog(`Account ${i + 1} - Auto Claim Faucet disabled, skipping.`, "info");
      }

      if (shouldStop) break;

      const useRandomUpId = dailyActivityConfig.randomUpIdEnabled;
      const hasSendTargets = useRandomUpId || upidTargets.length > 0;

      if (dailyActivityConfig.sendEnabled && hasSendTargets) {
        const d = Math.floor(Math.random() * (12000 - 6000 + 1)) + 6000;
        addLog(`Waiting ${Math.floor(d / 1000)}s before Auto Send TEST...`, "delay");
        await sleep(d);
      }

      if (dailyActivityConfig.sendEnabled && !shouldStop) {
        if (!hasSendTargets) {
          addLog(
            `Account ${i + 1} - No UP ID targets. Add upid.txt or enable Random UP ID.`,
            "warn"
          );
        } else {
          const reps = dailyActivityConfig.sendRepetitions || 1;
          const modeLabel = useRandomUpId
            ? `Random UP ID (last ${RANDOM_UPID_BLOCK_RANGE} blocks)`
            : `upid.txt (${upidTargets.length} targets)`;
          addLog(`Account ${i + 1} - Starting Auto Send TEST (${reps}x) | Mode: ${modeLabel}`, "info");

          if (useRandomUpId) {
            try {
              await getRandomUpIdTarget(provider);
            } catch (e) {
              addLog(`Account ${i + 1} - Random UP ID pool failed: ${e.message}`, "error");
            }
          }

          for (let s = 0; s < reps && !shouldStop; s++) {
            let target = null;
            try {
              if (useRandomUpId) {
                target = await getRandomUpIdTarget(provider);
              } else {
                target = upidTargets[Math.floor(Math.random() * upidTargets.length)];
              }
            } catch (e) {
              addLog(`Account ${i + 1} - Pick UP ID failed: ${e.message}`, "error");
              break;
            }

            const amount = getRandomAmount(
              dailyActivityConfig.sendAmountMin,
              dailyActivityConfig.sendAmountMax
            );
            addLog(
              `Account ${i + 1} - Send ${s + 1}/${reps} ➯ ${target}.up.id (${amount} TEST)${useRandomUpId ? " [random]" : ""}`,
              "wait"
            );
            try {
              await performSendTest(wallet, provider, target, amount);
            } catch (e) {
              addLog(`Account ${i + 1} - Send ${s + 1} failed: ${e.message}`, "error");
              delete nonceTracker[`${GIWA_CHAIN_ID}_${wallet.address.toLowerCase()}`];
            } finally {
              await updateWallets();
            }
            if (shouldStop) break;
            if (s < reps - 1) {
              const delay = Math.floor(Math.random() * (15000 - 8000 + 1)) + 8000;
              addLog(`Waiting ${Math.floor(delay / 1000)}s before next send...`, "delay");
              await sleep(delay);
            }
          }
          addLog(`Account ${i + 1} - Auto Send TEST Done`, "success");
        }
      } else {
        addLog(`Account ${i + 1} - Auto Send TEST disabled, skipping.`, "info");
      }

      addLog(`Account ${i + 1} - All daily tasks completed`, "success");

      if (i < accounts.length - 1 && !shouldStop) {
        const acctDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
        addLog(`Waiting ${Math.floor(acctDelay / 1000)}s before next account...`, "delay");
        await sleep(acctDelay);
      }
    }

    if (!shouldStop) {
      addLog(`All accounts processed! Next cycle in ${dailyActivityConfig.loopHours} hours.`, "success");
      dailyActivityInterval = setTimeout(runDailyActivity, dailyActivityConfig.loopHours * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity error: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      if (activeProcesses <= 0) _resetState();
      else {
        const chk = setInterval(() => {
          if (activeProcesses <= 0) { clearInterval(chk); _resetState(); }
        }, 1000);
      }
    } else {
      activityRunning = false;
      isCycleRunning  = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

function _resetState() {
  if (dailyActivityInterval) { clearTimeout(dailyActivityInterval); dailyActivityInterval = null; }
  activityRunning         = false;
  isCycleRunning          = false;
  shouldStop              = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses         = 0;
  addLog("Daily activity stopped successfully.", "success");
  updateMenu();
  updateStatus();
  safeRender();
}

const screen = blessed.screen({
  smartCSR:     true,
  title:        "GIWA PLAYGROUND AUTO BOT",
  autoPadding:  true,
  fullUnicode:  true,
  mouse:        true,
  ignoreLocked: ["C-c","q","escape"],
});

const headerBox = blessed.box({
  top:    0,
  left:   "center",
  width:  "100%",
  height: 8,
  tags:   true,
  style:  { fg: "cyan", bg: "default" },
});

const statusBox = blessed.box({
  left:    0,
  top:     8,
  width:   "100%",
  height:  3,
  tags:    true,
  border:  { type: "line" },
  style:   { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label:   chalk.cyan(" Status "),
  wrap:    true,
});

const walletBox = blessed.list({
  label:      " Wallet Information ",
  top:        11,
  left:       0,
  width:      "40%",
  height:     "35%",
  border:     { type: "line" },
  style:      { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar:  { bg: "cyan", fg: "black" },
  padding:    { left: 1, right: 1, top: 0, bottom: 0 },
  tags:       true,
  keys:       true,
  vi:         true,
  mouse:      true,
  content:    "Loading wallet data...",
});

const logBox = blessed.log({
  label:        " Transaction Logs ",
  top:          11,
  left:         "41%",
  width:        "59%",
  height:       "100%-11",
  border:       { type: "line" },
  scrollable:   true,
  alwaysScroll: true,
  mouse:        true,
  tags:         true,
  scrollbar:    { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback:   500,
  smoothScroll: true,
  style:        { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding:      { left: 1, right: 1, top: 0, bottom: 0 },
  wrap:         true,
  focusable:    true,
  keys:         true,
});

const menuBox = blessed.list({
  label:   " Menu ",
  top:     "46%",
  left:    0,
  width:   "40%",
  height:  "54%",
  keys:    true,
  vi:      true,
  mouse:   true,
  border:  { type: "line" },
  style: {
    fg: "white", bg: "default",
    border:   { fg: "red" },
    selected: { bg: "magenta", fg: "black" },
    item:     { fg: "white" },
  },
  items:   ["Start Auto Daily Activity", "Toggle Settings", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 },
});

const toggleSubMenu = blessed.list({
  label:  " Toggle Settings ",
  top:    "46%",
  left:   0,
  width:  "40%",
  height: "54%",
  keys:   true,
  vi:     true,
  mouse:  true,
  border: { type: "line" },
  style: {
    fg: "white", bg: "default",
    border:   { fg: "green" },
    selected: { bg: "green", fg: "black" },
    item:     { fg: "white" },
  },
  items: [
    "Toggle Issue Dojang (On/Off)",
    "Toggle Claim Faucet (On/Off)",
    "Toggle Send TEST (On/Off)",
    "Toggle Random UP ID (On/Off)",
    "Back to Main Menu",
  ],
  padding: { left: 1, top: 1 },
  hidden:  true,
});

const configSubMenu = blessed.list({
  label:  " Manual Config ",
  top:    "46%",
  left:   0,
  width:  "40%",
  height: "54%",
  keys:   true,
  vi:     true,
  mouse:  true,
  border: { type: "line" },
  style: {
    fg: "white", bg: "default",
    border:   { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item:     { fg: "white" },
  },
  items: [
    "Set Send Repetitions",
    "Set Send Amount Range",
    "Set Loop Hours",
    "Back to Main Menu",
  ],
  padding: { left: 1, top: 1 },
  hidden:  true,
});

const configForm = blessed.form({
  label:   " Enter Config Value ",
  top:     "center",
  left:    "center",
  width:   "30%",
  height:  "40%",
  keys:    true,
  mouse:   true,
  border:  { type: "line" },
  style:   { fg: "white", bg: "default", border: { fg: "blue" } },
  padding: { left: 1, top: 1 },
  hidden:  true,
});

const minLabel = blessed.text({
  parent:  configForm,
  top:     0,
  left:    1,
  content: "Min Value:",
  style:   { fg: "white" },
  hidden:  true,
});
const configInput = blessed.textbox({
  parent:       configForm,
  top:          1,
  left:         1,
  width:        "90%",
  height:       3,
  border:       { type: "line" },
  style:        { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } },
  inputOnFocus: true,
  keys:         true,
  mouse:        true,
});
const maxLabel = blessed.text({
  parent:  configForm,
  top:     4,
  left:    1,
  content: "Max Value:",
  style:   { fg: "white" },
  hidden:  true,
});
const configInputMax = blessed.textbox({
  parent:       configForm,
  top:          5,
  left:         1,
  width:        "90%",
  height:       3,
  border:       { type: "line" },
  style:        { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } },
  inputOnFocus: true,
  keys:         true,
  mouse:        true,
  hidden:       true,
});
const configSubmitButton = blessed.button({
  parent:    configForm,
  top:       9,
  left:      "center",
  width:     10,
  height:    3,
  content:   "Submit",
  align:     "center",
  border:    { type: "line" },
  clickable: true,
  keys:      true,
  mouse:     true,
  style: {
    fg: "white", bg: "blue",
    border: { fg: "white" },
    hover:  { bg: "green" },
    focus:  { bg: "green", border: { fg: "yellow" } },
  },
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(toggleSubMenu);
screen.append(configSubMenu);
screen.append(configForm);

let renderQueue      = [];
let isRendering      = false;
let isHeaderRendered = false;

function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err && data) {
            headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          } else {
            headerBox.setContent(`{center}{bold}{cyan-fg}  NT EXHAUST  {/cyan-fg}{/bold}{/center}`);
          }
          isHeaderRendered = true;
          screen.render();
        });
      } else {
        screen.render();
      }
    } catch {}
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const H = screen.height || 24;
  const W = screen.width  || 80;
  headerBox.height  = Math.max(8, Math.floor(H * 0.15));
  statusBox.top     = headerBox.height;
  statusBox.height  = Math.max(3, Math.floor(H * 0.07));
  statusBox.width   = W - 2;
  walletBox.top     = headerBox.height + statusBox.height;
  walletBox.width   = Math.floor(W * 0.4);
  walletBox.height  = Math.floor(H * 0.35);
  logBox.top        = headerBox.height + statusBox.height;
  logBox.left       = Math.floor(W * 0.41);
  logBox.width      = W - walletBox.width - 2;
  logBox.height     = H - (headerBox.height + statusBox.height);
  menuBox.top       = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width     = Math.floor(W * 0.4);
  menuBox.height    = H - (headerBox.height + statusBox.height + walletBox.height);
  toggleSubMenu.top    = menuBox.top;
  toggleSubMenu.width  = menuBox.width;
  toggleSubMenu.height = menuBox.height;
  toggleSubMenu.left   = menuBox.left;
  configSubMenu.top    = menuBox.top;
  configSubMenu.width  = menuBox.width;
  configSubMenu.height = menuBox.height;
  configSubMenu.left   = menuBox.left;
  configForm.width  = Math.floor(W * 0.3);
  configForm.height = Math.floor(H * 0.4);
  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const spinner = loadingSpinner[spinnerIndex];
    const status  = activityRunning
      ? `${spinner} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${spinner} ${chalk.yellowBright("Waiting next cycle")}`
      : chalk.green("Idle");

    const dojSt  = dailyActivityConfig.issueDojangEnabled
      ? chalk.greenBright("DOJ:ON")
      : chalk.redBright("DOJ:OFF");
    const fauSt  = dailyActivityConfig.claimFaucetEnabled
      ? chalk.greenBright("FAU:ON")
      : chalk.redBright("FAU:OFF");
    const sndSt  = dailyActivityConfig.sendEnabled
      ? chalk.greenBright(`SND:ON(${dailyActivityConfig.sendRepetitions}x)`)
      : chalk.redBright("SND:OFF");
    const rndSt  = dailyActivityConfig.randomUpIdEnabled
      ? chalk.greenBright("RND:ON")
      : chalk.redBright("RND:OFF");
    const upidSrc = dailyActivityConfig.randomUpIdEnabled
      ? `chain(${randomUpIdCache.names.length || "?"})`
      : String(upidTargets.length);

    statusBox.setContent(
      `Status: ${status} | ${getShortAddress(walletInfo.address)} | Accounts: ${accounts.length} | ` +
      `${dojSt} | ${fauSt} | ${sndSt} | ${rndSt} | UPID: ${upidSrc} | Loop: ${dailyActivityConfig.loopHours}h | GIWA`
    );

    if (isProcessing) {
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch {}
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header =
      `${chalk.bold.cyan("  Address".padEnd(16))}` +
      `  ${chalk.bold.cyan("ETH".padEnd(10))}` +
      `  ${chalk.bold.cyan("TEST".padEnd(10))}` +
      `  ${chalk.bold.cyan("UP ID")}`;
    const separator = chalk.gray("─".repeat(48));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallets: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch {}
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Toggle Settings", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Toggle Settings", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch {}
}

function showMainMenu() {
  toggleSubMenu.hide();
  configSubMenu.hide();
  configForm.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg       = "red";
      configSubMenu.style.border.fg = "blue";
      toggleSubMenu.style.border.fg = "green";
      logBox.style.border.fg        = "magenta";
      safeRender();
    }
  }, 100);
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"],   () => { if (screen.focused === logBox) { logBox.scroll(-1); safeRender(); } });
logBox.key(["down"], () => { if (screen.focused === logBox) { logBox.scroll(1);  safeRender(); } });
logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg        = "yellow";
  menuBox.style.border.fg       = "red";
  configSubMenu.style.border.fg = "blue";
  toggleSubMenu.style.border.fg = "green";
  safeRender();
});
logBox.on("blur", () => { logBox.style.border.fg = "magenta"; safeRender(); });

menuBox.on("select", async (item) => {
  const action = item.getText().trim();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) { addLog("Cycle already running. Stop it first.", "error"); break; }
      await runDailyActivity();
      break;

    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) { clearTimeout(dailyActivityInterval); dailyActivityInterval = null; }
      addLog("Stopping... waiting for current process to finish.", "warn");
      if (activeProcesses <= 0) {
        activityRunning = false; isCycleRunning = false; shouldStop = false;
        hasLoggedSleepInterrupt = false;
        addLog("Daily activity stopped.", "success");
        updateMenu(); updateStatus(); safeRender();
      } else {
        const chk = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(chk);
            activityRunning = false; isCycleRunning = false; shouldStop = false;
            hasLoggedSleepInterrupt = false; activeProcesses = 0;
            addLog("Daily activity stopped.", "success");
            updateMenu(); updateStatus(); safeRender();
          }
        }, 1000);
      }
      break;

    case "Toggle Settings":
      menuBox.hide();
      toggleSubMenu.show();
      setTimeout(() => {
        if (toggleSubMenu.visible) {
          screen.focusPush(toggleSubMenu);
          toggleSubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;

    case "Set Manual Config":
      menuBox.hide();
      configSubMenu.show();
      setTimeout(() => {
        if (configSubMenu.visible) {
          screen.focusPush(configSubMenu);
          configSubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;

    case "Clear Logs":
      clearTransactionLogs();
      break;

    case "Refresh":
      addLog("Refreshing wallet data...", "wait");
      Object.keys(upIdNameCache).forEach((k) => delete upIdNameCache[k]);
      randomUpIdCache = { names: [], fetchedAt: 0 };
      loadUpIdTargets();
      await updateWallets();
      break;

    case "Exit":
      addLog("Exiting...", "info");
      process.exit(0);
  }
});

toggleSubMenu.on("select", (item) => {
  const action = item.getText().trim();
  if (action.includes("Dojang")) {
    dailyActivityConfig.issueDojangEnabled = !dailyActivityConfig.issueDojangEnabled;
    saveConfig(); updateStatus();
    addLog(`Auto Issue Dojang ${dailyActivityConfig.issueDojangEnabled ? "ENABLED" : "DISABLED"}`,
      dailyActivityConfig.issueDojangEnabled ? "success" : "warn");
    safeRender(); return;
  }
  if (action.includes("Faucet")) {
    dailyActivityConfig.claimFaucetEnabled = !dailyActivityConfig.claimFaucetEnabled;
    saveConfig(); updateStatus();
    addLog(`Auto Claim Faucet ${dailyActivityConfig.claimFaucetEnabled ? "ENABLED" : "DISABLED"}`,
      dailyActivityConfig.claimFaucetEnabled ? "success" : "warn");
    safeRender(); return;
  }
  if (action.includes("Send TEST")) {
    dailyActivityConfig.sendEnabled = !dailyActivityConfig.sendEnabled;
    saveConfig(); updateStatus();
    addLog(`Auto Send TEST ${dailyActivityConfig.sendEnabled ? "ENABLED" : "DISABLED"}`,
      dailyActivityConfig.sendEnabled ? "success" : "warn");
    safeRender(); return;
  }
  if (action.includes("Random UP ID")) {
    dailyActivityConfig.randomUpIdEnabled = !dailyActivityConfig.randomUpIdEnabled;
    randomUpIdCache = { names: [], fetchedAt: 0 };
    saveConfig(); updateStatus();
    if (dailyActivityConfig.randomUpIdEnabled) {
      addLog(
        `Random UP ID ENABLED — targets from last ${RANDOM_UPID_BLOCK_RANGE} blocks `,
        "success"
      );
    } else {
      addLog(
        `Random UP ID DISABLED — Auto Send uses targets from upid.txt (${upidTargets.length} names)`,
        "warn"
      );
    }
    safeRender(); return;
  }
  if (action.includes("Back")) { showMainMenu(); return; }
});
toggleSubMenu.key(["escape"], () => showMainMenu());

const rangeConfigKeys = {
  "Set Send Repetitions":  { type: "sendRepetitions", hasRange: false },
  "Set Send Amount Range": { type: "sendAmount",      hasRange: true  },
  "Set Loop Hours":        { type: "loopHours",       hasRange: false },
};

configSubMenu.on("select", (item) => {
  const action = item.getText().trim();
  if (action === "Back to Main Menu") { showMainMenu(); return; }

  const cfg = rangeConfigKeys[action];
  if (!cfg) return;

  configForm.configType = cfg.type;
  configForm.setLabel(` ${action} `);
  if (cfg.hasRange) {
    minLabel.show(); maxLabel.show(); configInputMax.show();
    const minK = cfg.type + "Min", maxK = cfg.type + "Max";
    configInput.setValue(String(dailyActivityConfig[minK] || 0.01));
    configInputMax.setValue(String(dailyActivityConfig[maxK] || 0.05));
  } else {
    minLabel.hide(); maxLabel.hide(); configInputMax.hide();
    configInput.setValue(String(dailyActivityConfig[cfg.type] || 1));
  }
  configForm.show();
  setTimeout(() => {
    if (configForm.visible) { screen.focusPush(configInput); configInput.clearValue(); safeRender(); }
  }, 100);
});
configSubMenu.key(["escape"], () => showMainMenu());

const rangeTypes = ["sendAmount"];
const repTypes   = ["sendRepetitions", "loopHours"];
let isSubmitting = false;

configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;
  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    value = repTypes.includes(configForm.configType) ? parseInt(inputValue) : parseFloat(inputValue);
    if (rangeTypes.includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value.", "error");
        configInputMax.clearValue(); screen.focusPush(configInputMax); safeRender();
        isSubmitting = false; return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Enter a positive number.", "error");
      configInput.clearValue(); screen.focusPush(configInput); safeRender();
      isSubmitting = false; return;
    }
  } catch (err) {
    addLog(`Invalid format: ${err.message}`, "error");
    configInput.clearValue(); screen.focusPush(configInput); safeRender();
    isSubmitting = false; return;
  }

  if (repTypes.includes(configForm.configType)) {
    dailyActivityConfig[configForm.configType] = Math.floor(value);
    addLog(`${configForm.configType} set to ${Math.floor(value)}`, "success");
  } else if (rangeTypes.includes(configForm.configType)) {
    if (value > maxValue) {
      addLog("Min cannot exceed Max.", "error");
      configInput.clearValue(); screen.focusPush(configInput); safeRender();
      isSubmitting = false; return;
    }
    dailyActivityConfig[configForm.configType + "Min"] = value;
    dailyActivityConfig[configForm.configType + "Max"] = maxValue;
    addLog(`${configForm.configType} range: ${value} - ${maxValue}`, "success");
  }

  saveConfig(); updateStatus();
  configForm.hide();
  configSubMenu.show();
  setTimeout(() => {
    if (configSubMenu.visible) { screen.focusPush(configSubMenu); safeRender(); }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (rangeTypes.includes(configForm.configType)) screen.focusPush(configInputMax);
  else configForm.submit();
});
configInputMax.key(["enter"], () => configForm.submit());
configSubmitButton.on("press", () => configForm.submit());
configSubmitButton.on("click", () => { screen.focusPush(configSubmitButton); configForm.submit(); });
configForm.key(["escape"], () => {
  configForm.hide(); configSubMenu.show();
  setTimeout(() => { if (configSubMenu.visible) { screen.focusPush(configSubMenu); safeRender(); } }, 100);
});

screen.key(["escape","q","C-c"], () => {
  addLog("Exiting application", "info");
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    loadUpIdTargets();
    updateMenu();
    updateStatus();
    await updateWallets();
    safeRender();
    menuBox.focus();
    addLog(`GIWA Playground Auto Bot Ready! Accounts: ${accounts.length}`, "success");
    addLog(`Network: GIWA Sepolia (chainId ${GIWA_CHAIN_ID}) | RPC: sepolia-rpc.giwa.io`, "info");
    addLog(`Features: Auto Issue Dojang | Auto Claim Faucet | Auto Send TEST (UP ID)`, "info");
    addLog(
      `Send mode: ${dailyActivityConfig.randomUpIdEnabled
        ? `Random UP ID (last ${RANDOM_UPID_BLOCK_RANGE} blocks, like playground)`
        : "upid.txt list"}`,
      "info"
    );
    addLog(`pk.txt = keys | upid.txt = targets (if Random OFF) | proxy.txt = proxy`, "warn");
    addLog(`Toggle Settings → Random UP ID to switch source of send recipients.`, "info");
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
