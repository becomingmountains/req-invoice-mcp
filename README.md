# req-invoice-mcp

[![npm](https://img.shields.io/npm/v/req-invoice-mcp)](https://www.npmjs.com/package/req-invoice-mcp) [![req-invoice-mcp MCP server](https://glama.ai/mcp/servers/becomingmountains/req-invoice-mcp/badges/score.svg)](https://glama.ai/mcp/servers/becomingmountains/req-invoice-mcp)

Let your AI assistant send crypto invoices and tell you when they're paid.

An [MCP](https://modelcontextprotocol.io) server for [Request Network](https://request.network): any MCP-capable assistant (Cursor, VS Code, Windsurf, desktop AI apps, your own agent) can create invoices, share payment links and check payment status in plain language.

> "Invoice Acme 500 USDC for the website."
> "Has Acme paid yet?"

**It holds no wallet and can't spend money.** It creates and reads invoices only. Payers pay from their own wallet.

![Demo: create a payment link, the payer pays, the assistant confirms it's paid. Real run on Sepolia testnet.](https://raw.githubusercontent.com/becomingmountains/req-invoice-mcp/main/assets/demo.gif)

<sub>Real run on Sepolia testnet: [the payment transaction](https://sepolia.etherscan.io/tx/0x66d0e4cff82b1c6ba0a4670436908bbdd46ed273075364af5b3226e3565cc2f6).</sub>

📖 **Docs:** https://becomingmountains.github.io/req-invoice-mcp/ (source in [`site/`](site/))

> Unofficial community project. Not affiliated with or endorsed by Request Network.

## Tools

| Tool | What it does |
|---|---|
| `create_payment_link` | Bill someone and get a link they open to pay, in any of your currencies and networks. |
| `list_routes` | The currencies and networks you can be paid in. |
| `create_invoice` | Create an invoice in a specific token and network, bill in USD, or repeat it monthly for retainers. |
| `stop_recurring_invoice` | Stop (or resume) a repeating invoice. |
| `check_invoice` | Paid or not, with the payment transaction. Flags short payments and overpayments. Ask by name: "has Acme paid?" |
| `get_payment_link` | The saved link for an invoice, so you can send it again. |
| `list_invoices` | Who owes you what, with exact totals (part-paid invoices count what's left). Filters: unpaid, part-paid, overpaid, this month, older than 2 weeks, by name. |
| `get_payment_transactions` | For payers: the unsigned transactions to pay an invoice in their own wallet. |
| `find_currency` | Look up currency IDs like `USDC-base` or `fUSDC-sepolia`. |

## Quick start

1. **Get a free Client ID.** Sign in at [dashboard.request.network](https://dashboard.request.network) with your wallet, set up a receiving route (network, wallet, token), then **Manage → Client IDs → Generate**. Copy the **Route ID** too.
2. **Add the server to your MCP client** (Node 20+):

```json
{
  "mcpServers": {
    "req-invoice": {
      "command": "npx",
      "args": ["-y", "req-invoice-mcp"],
      "env": {
        "REQUEST_CLIENT_ID": "your-client-id",
        "REQUEST_DESTINATION_ID": "0xYourWallet@eip155:1#ABCD1234:0xTokenAddress",
        "REQUEST_PAYEE": "0xYourWallet"
      }
    }
  }
}
```

3. **Ask:** "Create a payment link for 25 USDC."

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `REQUEST_CLIENT_ID` or `REQUEST_API_KEY` | yes | Request Network credentials. |
| `REQUEST_ORIGIN` | no | Only if your Client ID is restricted to a domain: an origin it allows. |
| `REQUEST_DESTINATION_ID` | for links | One dashboard Route ID. Enables `create_payment_link`. |
| `REQUEST_ROUTES` | for several currencies | Several Route IDs, comma-separated, each optionally `=CLIENT_ID`. The first is the default. |
| `REQUEST_PAYEE` | for `create_invoice` with an API key | Default wallet that gets paid. |
| `REQUEST_NOTES_FILE` | no | Local notebook of names, notes and links (default `~/.config/req-invoice-mcp/invoices.json`, `off` to disable). |
| `REQUEST_API_URL` | no | API base URL (default `https://api.request.network`). |

## Testing on Sepolia

Use a fresh wallet. Set up a Sepolia receiving route in the dashboard, get test ETH from a Sepolia faucet and test USDC from [faucet.circle.com](https://faucet.circle.com), then create a link, pay it and run `check_invoice`.

## Safety

- No private keys, no signing, no sending. Nothing in this server can move funds.
- `get_payment_transactions` returns unsigned transactions for the payer to review in their own wallet.
- Inputs are validated before any API call (addresses, amounts, IDs), so a confused model can't reach other API paths.
- Credentials stay in your MCP client's config and are never echoed back in tool output.

## Development

```bash
npm install
npm test        # unit + MCP round-trip tests against a fake API
npm run build
```

## License

MIT
