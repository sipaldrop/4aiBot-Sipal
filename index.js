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
const AGENT_ABI = [
    'function submitAgent(uint256 agentId, string name, string description) external',
    'function submitRequest(uint256 requestId, string title) external'
];

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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
];

// --- UTILITIES ---
function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function generateTid() { return `${Date.now()}-${uuidv4()}`; }

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

        const axiosConfig = {
            baseURL: CONFIG.baseUrl,
            timeout: 30000,
            headers: this.generateHeaders()
        };

        if (proxyUrl) {
            const agent = proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
            axiosConfig.httpsAgent = agent;
            axiosConfig.httpAgent = agent;
        }

        this.axios = axios.create(axiosConfig);
        this.sessionTid = null;
    }

    generateHeaders() {
        const ua = getRandomItem(USER_AGENTS);
        return {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': CONFIG.baseUrl,
            'Referer': `${CONFIG.baseUrl}/final-run`,
            'User-Agent': ua,
            'Connection': 'keep-alive'
        };
    }

    async login() {
        try {
            log(this.index, 'Login...', 'info');
            this.sessionTid = generateTid();

            const nonceRes = await this.axios.post(CONFIG.endpoints.loginWallet, { addr: this.address }, { headers: { tid: this.sessionTid } });
            if (nonceRes.data.code !== 0) throw new Error(nonceRes.data.message);

            const nonce = nonceRes.data.data.nonce;
            const signature = await this.wallet.signMessage(nonce);

            const authRes = await this.axios.post(CONFIG.endpoints.authWallet, {
                addr: this.address, signature, nonce
            }, { headers: { tid: this.sessionTid } });

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
            const taskRes = await this.axios.post(CONFIG.endpoints.verifyDailyTask, {}, { headers: { tid: this.sessionTid } });
            const taskData = taskRes.data.data;

            let status = 'Tasks Done';
            let performed = 0;

            // 1. Create Request
            if (!taskData?.is_create_request) {
                log(this.index, 'Creating Request...', 'info');
                const title = getRandomItem(TITLES);
                const reqRes = await this.axios.post(CONFIG.endpoints.createRequest, {
                    title, content: getRandomContent(), is_mobile: false
                }, { headers: { tid: this.sessionTid } });

                if (reqRes.data.code === 0) {
                    await sleep(5000);
                    // On-Chain
                    const tx = await this.wallet.sendTransaction({
                        to: BSC_CONFIG.agentContract,
                        data: this.agentContract.interface.encodeFunctionData('submitRequest', [reqRes.data.data.id, title])
                    });
                    await tx.wait();
                    log(this.index, 'Request Completed ✅', 'success');
                    performed++;
                }
            }

            // 2. Create Agent
            if (!taskData?.is_create_agent) {
                log(this.index, 'Creating Agent...', 'info');
                const name = getRandomAgentName();
                const agentRes = await this.axios.post(CONFIG.endpoints.createRepositories, {
                    name, tag: [0], description: getRandomItem(AGENT_DESCRIPTIONS)
                }, { headers: { tid: this.sessionTid } });

                if (agentRes.data.code === 0) {
                    await sleep(5000);
                    // On-Chain
                    const tx = await this.wallet.sendTransaction({
                        to: BSC_CONFIG.agentContract,
                        data: this.agentContract.interface.encodeFunctionData('submitAgent', [agentRes.data.data.id, name, getRandomItem(AGENT_DESCRIPTIONS)])
                    });
                    await tx.wait();
                    log(this.index, 'Agent Completed ✅', 'success');
                    performed++;
                }
            }

            // Get updated points
            const userRes = await this.axios.post(CONFIG.endpoints.userInfo, {}, { headers: { tid: this.sessionTid } });
            const points = userRes.data.data?.credit || 0;

            return { success: true, points, status: performed > 0 ? 'Work Done' : 'Already Done' };

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
