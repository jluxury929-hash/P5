const { ethers, Wallet, WebSocketProvider, JsonRpcProvider, Contract, Interface } = require('ethers');
require('dotenv').config();

// 1. BOOTSTRAP
console.log("-----------------------------------------");
console.log("🟢 [BOOT] OMNISCIENT WHALE TITAN INITIALIZING...");

// 2. AUTO-UPGRADE INFRASTRUCTURE
// Converts WSS (Listening) to HTTPS (Execution) automatically
const RAW_WSS = process.env.WSS_URL || "";
const EXECUTION_URL = RAW_WSS.replace("wss://", "https://");

const CONFIG = {
    CHAIN_ID: 8453,
    TARGET_CONTRACT: "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0",
    
    // ⚡ DUAL-LANE CONNECTIVITY
    WSS_URL: RAW_WSS,          // Fast Listener
    RPC_URL: EXECUTION_URL,    // Reliable Executor
    
    // 🏦 ASSETS
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    
    // 🔮 ORACLES
    GAS_ORACLE: "0x420000000000000000000000000000000000000F", // Base L1 Fee
    CHAINLINK_FEED: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // ETH Price
    
    // 🐋 STRATEGY SETTINGS
    WHALE_THRESHOLD: ethers.parseEther("15"), // 15 ETH Trigger
    GAS_LIMIT: 1250000n, 
    PRIORITY_BRIBE: 15n, // 15% Tip to be FIRST
    MARGIN_ETH: process.env.MARGIN_ETH || "0.012"
};

// Global State
let currentEthPrice = 0;
let nextNonce = 0;

async function startOmniscientWhale() {
    // A. KEY SANITIZER (Fixes "Invalid Private Key" Crash)
    let rawKey = process.env.TREASURY_PRIVATE_KEY;
    if (!rawKey) { console.error("❌ FATAL: Private Key missing."); process.exit(1); }
    const cleanKey = rawKey.trim();

    try {
        // B. DUAL-PROVIDER SETUP
        // HTTP for heavy lifting (fetching full blocks, sims, trades)
        const httpProvider = new JsonRpcProvider(CONFIG.RPC_URL);
        const signer = new Wallet(cleanKey, httpProvider);
        
        // WSS for the "Signal" only
        const wsProvider = new WebSocketProvider(CONFIG.WSS_URL);
        await wsProvider.ready;

        console.log(`✅ SYSTEM ONLINE | EXECUTOR: ${CONFIG.RPC_URL.substring(0, 25)}...`);

        // C. CONTRACTS (Mapped to HTTP)
        const oracleContract = new Contract(CONFIG.GAS_ORACLE, ["function getL1Fee(bytes memory _data) public view returns (uint256)"], httpProvider);
        const priceFeed = new Contract(CONFIG.CHAINLINK_FEED, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], httpProvider);
        const titanIface = new Interface(["function requestTitanLoan(address,uint256,address[])"]);

        // Initialize Nonce
        nextNonce = await httpProvider.getTransactionCount(signer.address);

        // D. PRICE TRACKER
        wsProvider.on("block", async (blockNum) => {
            try {
                // 1. Update Price
                const [, price] = await priceFeed.latestRoundData();
                currentEthPrice = Number(price) / 1e8;
                process.stdout.write(`\r📦 BLOCK: ${blockNum} | ETH: $${currentEthPrice.toFixed(2)} | Scanning... `);

                // 2. FETCH FULL BLOCK (Via HTTP for stability)
                // We use HTTP here because fetching full blocks over WSS often causes disconnects
                const block = await httpProvider.getBlock(blockNum, true);
                if (!block || !block.transactions) return;

                // 3. WHALE FILTER
                const whaleMove = block.transactions.find(t => BigInt(t.value || 0) >= CONFIG.WHALE_THRESHOLD);

                if (whaleMove) {
                    console.log(`\n🚨 WHALE SPOTTED: ${ethers.formatEther(whaleMove.value)} ETH | Hash: ${whaleMove.hash.slice(0, 10)}...`);
                    
                    // 4. TRIGGER STRIKE LOGIC
                    await executeOmniscientStrike(whaleMove.hash, httpProvider, signer, titanIface, oracleContract);
                }

            } catch (e) { /* Ignore block fetch errors */ }
        });

        // E. IMMORTALITY PROTOCOL
        wsProvider.websocket.onclose = () => {
            console.warn("\n⚠️ WSS CLOSED. REBOOTING...");
            process.exit(1); 
        };

    } catch (e) {
        console.error(`\n❌ CRITICAL: ${e.message}`);
        setTimeout(startOmniscientWhale, 1000);
    }
}

// THE "OMNISCIENT" STRIKE LOGIC
async function executeOmniscientStrike(targetHash, provider, signer, iface, oracle) {
    try {
        // 1. DYNAMIC LOAN SIZING
        const balance = await provider.getBalance(signer.address);
        const ethBalance = parseFloat(ethers.formatEther(balance));
        // Scale loan: if rich borrow 100 ETH, if poor borrow 25 ETH
        const loanAmount = ethBalance > 0.1 ? ethers.parseEther("100") : ethers.parseEther("25");

        // 2. ENCODE DATA
        const strikeData = iface.encodeFunctionData("requestTitanLoan", [
            CONFIG.WETH, loanAmount, [CONFIG.WETH, CONFIG.USDC]
        ]);

        // 3. PRE-FLIGHT (Sim + L1 Fee + Gas Data)
        const [simulation, l1Fee, feeData] = await Promise.all([
            provider.call({ to: CONFIG.TARGET_CONTRACT, data: strikeData, from: signer.address }).catch(() => null),
            oracle.getL1Fee(strikeData),
            provider.getFeeData()
        ]);

        if (!simulation) return;

        // 4. COST CALCULATION (Including Aave Fee & L1 Data)
        const aaveFee = (loanAmount * 5n) / 10000n; // 0.05%
        const aggressivePriority = (feeData.maxPriorityFeePerGas * (100n + CONFIG.PRIORITY_BRIBE)) / 100n;
        
        const l2Cost = CONFIG.GAS_LIMIT * feeData.maxFeePerGas;
        const totalCost = l2Cost + l1Fee + aaveFee;
        
        const netProfit = BigInt(simulation) - totalCost;

        // 5. EXECUTION
        if (netProfit > ethers.parseEther(CONFIG.MARGIN_ETH)) {
            const profitUSD = parseFloat(ethers.formatEther(netProfit)) * currentEthPrice;
            console.log(`💎 PROFIT CONFIRMED: ${ethers.formatEther(netProfit)} ETH (~$${profitUSD.toFixed(2)})`);
            
            const tx = await signer.sendTransaction({
                to: CONFIG.TARGET_CONTRACT,
                data: strikeData,
                gasLimit: CONFIG.GAS_LIMIT,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: aggressivePriority, // Bribe to be FIRST
                nonce: nextNonce++,
                type: 2
            });
            
            console.log(`🚀 STRIKE FIRED: ${tx.hash}`);
            await tx.wait();
        }
    } catch (e) {
        if (e.message.includes("nonce")) nextNonce = await provider.getTransactionCount(signer.address);
    }
}

// EXECUTE
if (require.main === module) {
    startOmniscientWhale().catch(e => {
        console.error("FATAL ERROR. RESTARTING...");
        setTimeout(startOmniscientWhale, 1000);
    });
}
