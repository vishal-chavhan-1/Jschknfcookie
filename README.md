# Netflix Cookie Checker (Render Deploy)

Express app + Telegram bot for validating Netflix cookies in Netscape format.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. On Render, create a new **Web Service** from the repo (or use the included `render.yaml` Blueprint).
3. Set environment variable:
   - `CHAT_ID` — your Telegram chat ID (required for broadcast messages).
   - `RENDER_EXTERNAL_URL` — Render sets this automatically.
4. Deploy. The Telegram webhook is registered automatically on startup.

## Local run

```bash
npm install
CHAT_ID=your_chat_id npm start
```

Visit http://localhost:3000

## Notes

- Bot token is hardcoded in `index.js` (line 16). Rotate it if exposed.
- Auto-ping every 4 minutes keeps the free Render instance awake.
- Endpoints: `GET /`, `GET /ping`, `POST /check-file`, `POST /check-paste`, `POST /webhook/<BOT_TOKEN>`.
