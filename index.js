import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import Table from 'cli-table3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path Definitions
const ACCOUNTS_PATH = join(__dirname, 'accounts.json');
const CONFIG_PATH = join(__dirname, 'config.json');
const WALLET_DB_PATH = join(__dirname, 'wallet_db.json');

// --- LOAD CONFIG ---
let CONFIG = {};
try {
    const configFile = await fs.readFile(CONFIG_PATH, 'utf8');
    CONFIG = JSON.parse(configFile);
} catch (error) {
    console.error(chalk.red('❌ Error loading config.json. Please ensure it exists.'));
    process.exit(1);
}

const BSC_CONFIG = CONFIG.bscConfig;

// --- RESOURCES & CONSTANTS ---
// IMPORTANT: These are the CORRECT function selectors discovered from successful on-chain transactions.
// The contract is unverified so we use Interface with corrected selectors.
// Selector 0x9897934c = Agent submission (uint256, string, string)
// Selector 0xc9a5fadf = Request submission (uint256, string)
const AGENT_ABI = [
    // Use explicit function fragments that match the actual contract
    {
        "type": "function",
        "name": "submitAgentData",  // Placeholder name - selector is what matters
        "inputs": [
            { "name": "agentId", "type": "uint256" },
            { "name": "name", "type": "string" },
            { "name": "description", "type": "string" }
        ],
        "outputs": [],
        "stateMutability": "nonpayable"
    },
    {
        "type": "function",
        "name": "submitRequestData",  // Placeholder name - selector is what matters
        "inputs": [
            { "name": "requestId", "type": "uint256" },
            { "name": "title", "type": "string" }
        ],
        "outputs": [],
        "stateMutability": "nonpayable"
    }
];

// Correct function selectors from on-chain analysis
const FUNCTION_SELECTORS = {
    SUBMIT_AGENT: '0x9897934c',      // (uint256, string, string)
    SUBMIT_REQUEST: '0xc9a5fadf'     // (uint256, string)
};

const TITLES = [
    "exploring the future of decentralized", "blockchain technology is fascinating", "excited about web3 possibilities",
    "learning more about crypto daily", "another great day in web3 space", "the potential here is incredible",
    "building something amazing today", "diving deeper into blockchain tech", "crypto journey continues forward",
    "innovation happens every single day", "web3 is changing everything now", "decentralization matters so much",
    "excited for what comes next here", "this technology is revolutionary", "blockchain opens new possibilities",
    "the future is being built today", "learning and growing every day", "crypto space never stops moving"
];

const CONTENTS = [
    "The blockchain ecosystem continues to evolve in fascinating ways.", "Decentralization is more than a technology.",
    "Web3 represents a fundamental shift in ownership.", "Building in this space requires patience.",
    "The intersection of AI and blockchain is creating opportunities.", "Smart contracts are revolutionizing agreements.",
];

const AGENT_PREFIXES = ["Smart", "Auto", "Crypto", "DeFi", "Web3", "Chain", "Block", "Token", "AI", "Meta"];
const AGENT_SUFFIXES = ["Bot", "Agent", "Helper", "Assistant", "Trader", "Analyzer", "Worker", "Manager", "Guardian"];
const AGENT_DESCRIPTIONS = [
    "An intelligent agent for blockchain automation", "Automated trading solution", "AI-powered crypto assistant",
    "Smart contract interaction helper", "Decentralized task automation agent"
];

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
];

// --- UTILITIES ---
function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function generateTid() { return `${Date.now()}-${uuidv4()}`; }

async function runWithTimeout(promise, ms, errorMsg) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Enhanced Logging per Sipal Standard
function log(accountIndex, message, type = 'info') {
    const prefix = `[Acc ${accountIndex}]`;
    switch (type) {
        case 'success': console.log(`${chalk.green(prefix)} ${chalk.green(message)}`); break;
        case 'error': console.log(`${chalk.red(prefix)} ${chalk.red(message)}`); break;
        case 'warn': console.log(`${chalk.yellow(prefix)} ${chalk.yellow(message)}`); break;
        case 'wait': console.log(`${chalk.cyan(prefix)} ${chalk.cyan(message)}`); break;
        default: console.log(`${chalk.white(prefix)} ${message}`);
    }
}

function getRandomContent() {
    const id = Math.random().toString(36).substring(2, 12);
    return JSON.stringify([{ "children": [{ "text": getRandomItem(CONTENTS) }], "type": "p", "id": id }]);
}

function getRandomAgentName() {
    return `${getRandomItem(AGENT_PREFIXES)}${getRandomItem(AGENT_SUFFIXES)}${Math.floor(Math.random() * 1000)}`;
}

// --- DB MANAGER ---
class WalletDB {
    constructor() {
        this.data = {};
        this.load();
    }
    async load() {
        try {
            if (existsSync(WALLET_DB_PATH)) {
                const content = await fs.readFile(WALLET_DB_PATH, 'utf8');
                this.data = JSON.parse(content);
            }
        } catch (e) { this.data = {}; }
    }
    async save() {
        try { await fs.writeFile(WALLET_DB_PATH, JSON.stringify(this.data, null, 2)); } catch (e) { }
    }
    getNextRunTime(address) { return this.data[address.toLowerCase()] || 0; }
    updateNextRunTime(address, nextTime) {
        this.data[address.toLowerCase()] = nextTime;
        this.save();
    }
}

// --- API CLIENT ---
class FourBSCClient {
    constructor(privateKey, proxyUrl, index) {
        this.index = index;
        const provider = new ethers.JsonRpcProvider(BSC_CONFIG.rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, provider);
        this.address = this.wallet.address;
        this.proxyUrl = proxyUrl;

        this.agentContract = new ethers.Contract(BSC_CONFIG.agentContract, AGENT_ABI, this.wallet);

        // Initialize Axios with Proxy
        this.initAxios();
    }

    initAxios() {
        const axiosConfig = {
            baseURL: CONFIG.baseUrl,
            timeout: 60000, // Increased timeout
            headers: this.generateHeaders()
        };

        if (this.proxyUrl) {
            const agent = this.proxyUrl.startsWith('socks') ? new SocksProxyAgent(this.proxyUrl) : new HttpsProxyAgent(this.proxyUrl);
            axiosConfig.httpsAgent = agent;
            axiosConfig.httpAgent = agent;
        }

        this.axios = axios.create(axiosConfig);
    }

    generateHeaders() {
        const ua = getRandomItem(USER_AGENTS);
        return {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': CONFIG.baseUrl,
            'Referer': `${CONFIG.baseUrl}/final-run`,
            'User-Agent': ua,
            'Connection': 'keep-alive',
            'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
        };
    }

    async requestWithRetry(method, url, data = {}, options = {}, retries = 5) {
        for (let i = 0; i < retries; i++) {
            try {
                // Ensure fresh TID for every request
                const headers = { ...options.headers, tid: generateTid() };
                const res = await this.axios({ method, url, data, ...options, headers });

                // Check for logic error specifically for Token
                if (res.data && (res.data.message === 'TOKEN_INVALID' || res.data.message === 'Session expired')) {
                    log(this.index, `Token Invalid/Expired. Re-logging... (Attempt ${i + 1})`, 'warn');
                    const loginSuccess = await this.login();
                    if (loginSuccess) {
                        // Retry with fresh login token (axios default auth header is updated)
                        // but we must generate NEW TID again
                        const newHeaders = { ...options.headers, tid: generateTid() };
                        return await this.axios({ method, url, data, ...options, headers: newHeaders });
                    } else {
                        throw new Error('Re-login failed during retry');
                    }
                }

                return res;
            } catch (error) {
                const isAuthError = error.response && (error.response.status === 401 || error.response.status === 403);
                const isNetworkError = !error.response || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('Proxy connection');

                if (isAuthError) {
                    log(this.index, `Auth Error (401/403). Re-logging...`, 'warn');
                    const loginSuccess = await this.login();
                    if (loginSuccess) {
                        const newHeaders = { ...options.headers, tid: generateTid() };
                        return await this.axios({ method, url, data, ...options, headers: newHeaders });
                    }
                    throw error;
                }

                if (i < retries - 1) {
                    const delay = (i + 1) * 3000;
                    log(this.index, `Request Error (${url}): ${error.message}. Retrying in ${delay / 1000}s...`, 'warn');
                    await sleep(delay);

                    // Re-init axios on network errors to refresh proxy connection
                    if (isNetworkError) this.initAxios();
                } else {
                    throw error;
                }
            }
        }
    }

    async sendTransactionWithRetry(contractFunc, args, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                // Estimate Gas
                let gasLimit;
                try {
                    gasLimit = await contractFunc.estimateGas(...args);
                    gasLimit = (gasLimit * 120n) / 100n; // +20% buffer
                } catch (gasError) {
                    // Check for hard revert during estimation - usually means invalid logic/state
                    if (gasError.code === 'CALL_EXCEPTION' || gasError.message.includes('execution reverted')) {
                        log(this.index, `Gas Estimate Reverted: ${gasError.reason || 'No Reason'} (Check logic/state). Skipping Tx.`, 'error');
                        return false; // Stop immediately, do not retry
                    }
                    log(this.index, `Gas Calc Err: ${gasError.message}. Using Default.`, 'warn');
                    gasLimit = 500000n; // Fallback
                }

                // Send Tx
                const tx = await contractFunc(...args, { gasLimit });
                log(this.index, `Tx Sent: ${tx.hash}`, 'info');
                await tx.wait();
                return true;
            } catch (error) {
                // Hard Revert Check
                if (error.code === 'CALL_EXCEPTION' || error.message.includes('execution reverted')) {
                    log(this.index, `Tx Reverted: ${error.reason || 'No Reason'}. Skipping.`, 'error');
                    return false; // Stop immediately
                }

                if (i < retries - 1) {
                    log(this.index, `Tx Fail: ${error.message}. Retry ${i + 1}/${retries}`, 'warn');
                    await sleep(5000);
                } else {
                    log(this.index, `Tx Failed after retries: ${error.message}`, 'error');
                    return false;
                }
            }
        }
        return false;
    }

    // NEW: Send raw transaction with correct function selectors
    async sendRawTransaction(selector, paramTypes, paramValues, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                // Encode parameters without selector
                const abiCoder = ethers.AbiCoder.defaultAbiCoder();
                const encodedParams = abiCoder.encode(paramTypes, paramValues);

                // Combine selector + encoded params
                const calldata = selector + encodedParams.slice(2); // Remove 0x from params

                // Prepare transaction
                const txRequest = {
                    to: BSC_CONFIG.agentContract,
                    data: calldata,
                };

                // Estimate gas
                let gasLimit;
                try {
                    // Added timeout for gas estimation (10s)
                    gasLimit = await runWithTimeout(this.wallet.estimateGas(txRequest), 10000, 'Gas Estimate Timeout');
                    gasLimit = (gasLimit * 120n) / 100n; // +20% buffer
                } catch (gasError) {
                    if (gasError.message === 'Gas Estimate Timeout') {
                        log(this.index, `Gas Estimate Timed Out. Using Default 300k.`, 'warn');
                        gasLimit = 300000n;
                    } else if (gasError.code === 'CALL_EXCEPTION' || gasError.message.includes('execution reverted')) {
                        log(this.index, `Gas Estimate Reverted: ${gasError.reason || gasError.message?.slice(0, 50) || 'Unknown'} - Check if task already done on-chain`, 'error');
                        return false;
                    } else {
                        log(this.index, `Gas Calc Err: ${gasError.message}. Using Default 200k.`, 'warn');
                        gasLimit = 200000n;
                    }
                }

                // Send transaction with timeout (30s)
                const tx = await runWithTimeout(this.wallet.sendTransaction({ ...txRequest, gasLimit }), 30000, 'Tx Send Timeout');

                log(this.index, `Tx Sent: ${tx.hash}`, 'info');

                // Wait for receipt with timeout (60s)
                const receipt = await runWithTimeout(tx.wait(), 60000, 'Tx Wait Timeout');

                if (receipt.status === 1) {
                    return true;
                } else {
                    log(this.index, `Tx Mined but Failed. Check BSCScan.`, 'error');
                    return false;
                }
            } catch (error) {
                if (error.code === 'CALL_EXCEPTION' || error.message.includes('execution reverted')) {
                    log(this.index, `Tx Reverted: ${error.reason || 'No Reason'}. Skipping.`, 'error');
                    return false;
                }

                if (i < retries - 1) {
                    log(this.index, `Tx Fail: ${error.message}. Retry ${i + 1}/${retries}`, 'warn');
                    await sleep(5000);
                } else {
                    log(this.index, `Tx Failed after retries: ${error.message}`, 'error');
                    return false;
                }
            }
        }
        return false;
    }

    async login() {
        try {
            log(this.index, 'Login...', 'info');

            const nonceRes = await this.requestWithRetry('post', CONFIG.endpoints.loginWallet, { addr: this.address });
            if (nonceRes.data.code !== 0) throw new Error(nonceRes.data.message);

            const nonce = nonceRes.data.data.nonce;
            const signature = await this.wallet.signMessage(nonce);

            const authRes = await this.requestWithRetry('post', CONFIG.endpoints.authWallet, {
                addr: this.address, signature, nonce
            });

            if (authRes.data.code !== 0) throw new Error(authRes.data.message);

            this.token = authRes.data.data.token;
            this.axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;

            log(this.index, 'Login SUCCESS', 'success');
            return true;
        } catch (e) {
            log(this.index, `LOGIN FAILED: ${e.message}`, 'error');
            return false;
        }
    }

    async runDailyTasks() {
        if (!await this.login()) return { success: false, status: 'Login Failed' };

        log(this.index, 'Checking Daily Claim...', 'wait');

        try {
            // Verify Tasks
            // HAR shows content-length: 0, so we send undefined/null data to ensure empty body
            const taskRes = await this.requestWithRetry('post', CONFIG.endpoints.verifyDailyTask);
            const taskData = taskRes.data.data;

            // Explicit Status Check Logging
            const isRequestDone = taskData?.is_create_request;
            const isAgentDone = taskData?.is_create_agent;

            log(this.index, `Server Status -> Request: ${isRequestDone ? 'DONE ✅' : 'NOT DONE ❌'} | Agent: ${isAgentDone ? 'DONE ✅' : 'NOT DONE ❌'}`, 'info');

            let status = 'Tasks Done';
            let performed = 0;

            // 1. Create Request
            if (!isRequestDone) {
                log(this.index, 'Action: Starting Request Task...', 'info');
                const title = getRandomItem(TITLES);
                const reqRes = await this.requestWithRetry('post', CONFIG.endpoints.createRequest, {
                    title, content: getRandomContent(), is_mobile: false
                });

                if (reqRes.data.code === 0 && reqRes.data.data?.id) {
                    await sleep(2000);
                    // On-Chain with CORRECT selector 0xc9a5fadf
                    log(this.index, `Submitting Request ID ${reqRes.data.data.id} on-chain...`, 'info');
                    const success = await this.sendRawTransaction(
                        FUNCTION_SELECTORS.SUBMIT_REQUEST,
                        ['uint256', 'string'],
                        [reqRes.data.data.id, title]
                    );

                    if (success) {
                        log(this.index, 'Request Completed ✅', 'success');
                        performed++;
                    } else {
                        log(this.index, 'Request Tx Failed ❌ (Skipping to next task)', 'warn');
                    }
                } else {
                    log(this.index, `Create Request API Failed: ${reqRes.data.message}`, 'error');
                }
            } else {
                log(this.index, 'Skipping Request Task (Already Done)', 'info');
            }

            // 2. Create Agent
            if (!isAgentDone) {
                log(this.index, 'Action: Starting Agent Task...', 'info');
                const name = getRandomAgentName();
                const agentRes = await this.requestWithRetry('post', CONFIG.endpoints.createRepositories, {
                    name, tag: [0], description: getRandomItem(AGENT_DESCRIPTIONS)
                });

                if (agentRes.data.code === 0 && agentRes.data.data?.id) {
                    await sleep(2000);
                    // On-Chain with CORRECT selector 0x9897934c
                    const agentDescription = getRandomItem(AGENT_DESCRIPTIONS);
                    log(this.index, `Submitting Agent ID ${agentRes.data.data.id} on-chain...`, 'info');
                    const success = await this.sendRawTransaction(
                        FUNCTION_SELECTORS.SUBMIT_AGENT,
                        ['uint256', 'string', 'string'],
                        [agentRes.data.data.id, name, agentDescription]
                    );

                    if (success) {
                        log(this.index, 'Agent Completed ✅', 'success');
                        performed++;
                    } else {
                        log(this.index, 'Agent Tx Failed ❌ (Skipping)', 'warn');
                    }
                } else {
                    log(this.index, `Create Agent API Failed: ${agentRes.data.message}`, 'error');
                }
            } else {
                log(this.index, 'Skipping Agent Task (Already Done)', 'info');
            }

            // Get updated points from verify response
            try {
                // Extract points from taskData.message (e.g., "You've earned 150 pts.")
                let points = '-';
                if (taskData?.message) {
                    const match = taskData.message.match(/(\d+)\s*pts/i);
                    if (match) points = match[1];
                }
                log(this.index, `Points Status: ${taskData?.message || 'N/A'}`, 'info');
                return { success: true, points, status: performed > 0 ? 'Work Done' : 'Already Done' };
            } catch (err) {
                return { success: true, points: '?', status: performed > 0 ? 'Work Done' : 'Already Done' };
            }

        } catch (e) {
            log(this.index, `Task details: ${e.message}`, 'error');
            return { success: false, status: 'Error' };
        }
    }
}

// --- MAIN LOOP ---
async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log(`
Sipal 4BSC Bot V1.0
Usage: node index.js
Options:
  --help    Show this help message
        `);
        return;
    }

    // Sipal Banner
    console.log(chalk.blue(`
            / \\
              /   \\
            |  |  |
             |  |  |
            \\  \\
             |  |  |
             |  |  |
            \\   /
            \\ /
                `));
    console.log(chalk.bold.cyan('    ======SIPAL AIRDROP======'));
    console.log(chalk.bold.cyan('  =====SIPAL 4BSC BOT V1.0====='));

    // Load Accounts
    let accounts = [];
    try {
        const file = await fs.readFile(ACCOUNTS_PATH, 'utf8');
        accounts = JSON.parse(file);
    } catch (e) {
        console.error(chalk.red('❌ accounts.json not found!'));
        process.exit(1);
    }

    const db = new WalletDB();

    while (true) {
        const summaryData = [];
        let anyRun = false;

        console.log(chalk.yellow(`\n[${new Date().toLocaleTimeString()}]Starting Loop for ${accounts.length} accounts...`));

        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            const client = new FourBSCClient(acc.privateKey, acc.proxy, i + 1);

            const nextRun = db.getNextRunTime(client.address);
            if (Date.now() < nextRun) {
                summaryData.push([`Acc ${i + 1} `, '-', 'Skipped (Cooldown)', new Date(nextRun).toLocaleTimeString()]);
                continue;
            }

            anyRun = true;
            const res = await client.runDailyTasks();

            if (res.success) {
                db.updateNextRunTime(client.address, Date.now() + CONFIG.loopInterval);
                summaryData.push([`Acc ${i + 1} `, res.points || '-', res.status, new Date(Date.now() + CONFIG.loopInterval).toLocaleTimeString()]);
            } else {
                summaryData.push([`Acc ${i + 1} `, '-', 'Failed', 'Retry Next Loop']);
            }

            await sleep(2000); // Small delay between accounts
        }

        // --- GRAND SUMMARY ---
        console.log('\n' + chalk.bold.cyan('================================================================================'));
        console.log(chalk.bold.cyan(`                          🤖 SIPAL 4BSC BOT V1.0 🤖`));
        console.log(chalk.bold.cyan('================================================================================'));

        const table = new Table({
            head: ['Account', 'Points', 'Status', 'Next Run'],
            style: { head: ['cyan'], border: ['grey'] }
        });

        summaryData.forEach(row => table.push(row));

        console.log(table.toString());
        console.log(chalk.bold.cyan('================================================================================\n'));

        // Smart Sleep
        console.log(chalk.magenta('💤 Sleeping for 1 hour before next cycle check...'));
        await sleep(60 * 60 * 1000);
    }
}

main();
