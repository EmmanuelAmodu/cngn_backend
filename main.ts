// main.ts
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { 
  createPublicClient, 
  createWalletClient, 
  erc20Abi, 
  http,
  type Address, 
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { mainnet } from "viem/chains";

// ------------------------
// Database Setup (SQLite)
// ------------------------

// Table for onramp requests.
const db = new Database("data.sqlite");
db.run(`
  CREATE TABLE IF NOT EXISTS onramp_requests (
    onrampId TEXT PRIMARY KEY,
    userAddress TEXT,
    accountName TEXT,
    virtualAccount TEXT,
    bankName TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS offramps (
    offRampId TEXT PRIMARY KEY,
    userAddress TEXT,
    bankAccount TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    bankReference TEXT,
    userAddress TEXT,
    amount INTEGER,
    onrampId TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    userAddress TEXT,
    amount INTEGER,
    offRampId TEXT,
    processed INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS bridges (
    id TEXT PRIMARY KEY,
    userAddress TEXT,
    amount INTEGER,
    destinationChainId INTEGER,
    processed INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// -------------------------------------
// Blockchain (viem) & Contract Setup
// -------------------------------------
const RPC_URL = process.env.RPC_URL || "https://your-rpc-url";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xYourContractAddress";
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || "0xYourTokenAddress";

// Updated contract ABI with onrampId in the deposit function.
// Note: The contract should now emit a Deposit event including the onrampId.
const contractABI = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "name": "user", "type": "address" },
      { "indexed": false, "name": "amount", "type": "uint256" },
      { "indexed": false, "name": "onrampId", "type": "bytes32" }
    ],
    "name": "Deposit",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "name": "user", "type": "address" },
      { "indexed": false, "name": "amount", "type": "uint256" },
      { "indexed": false, "name": "offRampId", "type": "bytes32" }
    ],
    "name": "Withdrawal",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "name": "user", "type": "address" },
      { "indexed": false, "name": "amount", "type": "uint256" },
      { "indexed": false, "name": "destinationChainId", "type": "uint256" }
    ],
    "name": "Bridge",
    "type": "event"
  },
  {
    "inputs": [
      { "name": "to", "type": "address" },
      { "name": "amount", "type": "uint256" },
      { "name": "onrampId", "type": "bytes32" }
    ],
    "name": "deposit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

const publicClient = createPublicClient({
  transport: http(RPC_URL),
});

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY as Hex;
if (!ADMIN_PRIVATE_KEY) {
  throw new Error("ADMIN_PRIVATE_KEY environment variable not set");
}
const account = privateKeyToAccount(ADMIN_PRIVATE_KEY);
const walletClient = createWalletClient({
  account: account,
  transport: http(RPC_URL),
});

// Retrieve token decimals to correctly scale amounts.
const decimals: number = await publicClient.readContract({
  address: TOKEN_ADDRESS as `0x${string}`,
  abi: erc20Abi,
  functionName: "decimals",
  args: [],
});

// Watch for Withdrawal events using viem.
publicClient.watchContractEvent({
  address: CONTRACT_ADDRESS as `0x${string}`,
  abi: contractABI,
  eventName: "Withdrawal",
  onLogs: (logs) => {
    for (const log of logs) {
      const { args } = log;
      if (!args) continue;
      const user = args.user as string;
      const amount = Number(args.amount);
      const offRampId = args.offRampId as string;
      console.log("Withdrawal event detected:", user, amount, offRampId);
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO withdrawals (id, userAddress, amount, offRampId) VALUES (?, ?, ?, ?)"
      ).run(id, user, amount, offRampId);
    }
  },
});

// Watch for Bridge events using viem.
publicClient.watchContractEvent({
  address: CONTRACT_ADDRESS as `0x${string}`,
  abi: contractABI,
  eventName: "Bridge",
  onLogs: (logs) => {
    for (const log of logs) {
      const { args } = log;
      if (!args) continue;
      const user = args.user as string;
      const amount = Number(args.amount);
      const destinationChainId = Number(args.destinationChainId);
      console.log("Bridge event detected:", user, amount, destinationChainId);
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO bridges (id, userAddress, amount, destinationChainId) VALUES (?, ?, ?, ?)"
      ).run(id, user, amount, destinationChainId);
    }
  },
});

// ------------------------------
// Simulate Banking Provider API
// ------------------------------
async function getVirtualAccount(userAddress: string): Promise<{ virtualAccount: string, bankName: string, accountName: string }> {
  // Simulate an API call delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Generate a dummy virtual account number
  return {
    virtualAccount: `VA${userAddress.slice(2, 8)}${Math.floor(Math.random() * 10000)}`,
    accountName: "John Doe",
    bankName: "TEST BANK",
  };
}

// ------------------------------
// Elysia Server & API Endpoints
// ------------------------------
const app = new Elysia();

// POST /onramp/initiate
// Initiates an onramp request by obtaining a virtual account from the banking provider,
// generating an onrampId (as a bytes32 value), storing the info in the DB,
// and returning the details to the frontend.
app.post("/onramp/initiate", async (context) => {
  // Expected JSON body: { userAddress }
  const { userAddress } = context.body as { userAddress: Address };
  if (!userAddress) {
    return new Response("Invalid payload", { status: 400 });
  }
  
  // Generate a bytes32 onrampId
  const onrampId = `0x${randomBytes(32).toString("hex")}`;
  
  // Call the banking provider API (simulated)
  const { virtualAccount, bankName, accountName } = await getVirtualAccount(userAddress);
  
  // Save onramp request to the database
  db.prepare(
    "INSERT INTO onramp_requests (onrampId, userAddress, virtualAccount, bankName, accountName) VALUES (?, ?, ?, ?, ?)"
  ).run(onrampId, userAddress, virtualAccount, bankName, accountName);
  
  console.log(`Onramp initiated for user ${userAddress} with onrampId ${onrampId} and virtual account ${virtualAccount}`);
  
  return new Response(JSON.stringify({
    success: true,
    onrampId,
    virtualAccount,
    bankName
  }), { status: 200 });
});

// POST /webhook/deposit
// Receives fiat deposit notifications, records the deposit,
// and calls the contract's deposit() function passing along the onrampId.
app.post("/webhook/deposit", async (context) => {
  // Expected JSON body: { bankReference, userAddress, amount, onrampId }
  const { bankReference, userAddress, amount, onrampId } = context.body as {
    bankReference: string;
    userAddress: Address;
    amount: number;
    onrampId: Hex; // bytes32 string
  };
  if (!bankReference || !userAddress || !amount || !onrampId) {
    return new Response("Invalid payload", { status: 400 });
  }
  
  const depositId = `0x${randomBytes(32).toString("hex")}`;
  db.prepare(
    "INSERT INTO deposits (id, bankReference, userAddress, amount, onrampId) VALUES (?, ?, ?, ?, ?)"
  ).run(depositId, bankReference, userAddress, amount, onrampId);
  
  console.log(`Received fiat deposit: ${depositId} for user ${userAddress} amount ${amount}, onrampId: ${onrampId}`);
  
  // Call the deposit() function on the smart contract using viem's walletClient.
  try {
    const txHash = await walletClient.writeContract({
      address: CONTRACT_ADDRESS as `0x${string}`,
      abi: contractABI,
      functionName: "deposit",
      args: [userAddress, BigInt(amount * 10 ** decimals), onrampId],
      chain: mainnet,
    });
  
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Onramp deposit transaction successful:", txHash);
  } catch (error) {
    console.error("Deposit transaction failed:", error);
    return new Response("Deposit transaction failed", { status: 500 });
  }
  
  return new Response(JSON.stringify({ success: true, depositId }), { status: 200 });
});

// POST /register/offramp
// Registers a user's bank details for offramping.
app.post("/register/offramp", async (context) => {
  // Expected JSON body: { userAddress, bankAccount }
  const { userAddress, bankAccount } = context.body as {
    userAddress: string;
    bankAccount: string;
  };
  if (!userAddress || !bankAccount) {
    return new Response("Invalid payload", { status: 400 });
  }
  
  const offRampId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO offramps (offRampId, userAddress, bankAccount) VALUES (?, ?, ?)"
  ).run(offRampId, userAddress, bankAccount);
  
  console.log(`Registered offramp for user ${userAddress} with ID ${offRampId}`);
  return new Response(JSON.stringify({ success: true, offRampId }), { status: 200 });
});

// GET endpoints for querying records.
app.get("/deposits", async () => {
  const deposits = db.query("SELECT * FROM deposits").all();
  return new Response(JSON.stringify(deposits), { status: 200 });
});

app.get("/onramp_requests", async () => {
  const requests = db.query("SELECT * FROM onramp_requests").all();
  return new Response(JSON.stringify(requests), { status: 200 });
});

app.get("/offramps", async () => {
  const offramps = db.query("SELECT * FROM offramps").all();
  return new Response(JSON.stringify(offramps), { status: 200 });
});

app.get("/withdrawals", async () => {
  const withdrawals = db.query("SELECT * FROM withdrawals").all();
  return new Response(JSON.stringify(withdrawals), { status: 200 });
});

app.get("/bridges", async () => {
  const bridges = db.query("SELECT * FROM bridges").all();
  return new Response(JSON.stringify(bridges), { status: 200 });
});

// ------------------------------
// Start the Elysia Server
// ------------------------------
app.listen(3000, () => {
  console.log("Backend service running on port 3000");
});
