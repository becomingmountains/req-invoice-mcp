# req-invoice-mcp

Let your AI assistant send crypto invoices and tell you when they're paid.

An [MCP](https://modelcontextprotocol.io) server for [Request Network](https://request.network): any MCP-capable assistant (Cursor, VS Code, Windsurf, desktop AI apps, your own agent) can create invoices, share payment links and check payment status in plain language.

> "Invoice Acme 500 USDC for the website."
> "Has Acme paid yet?"

**It holds no wallet and can't spend money.** It creates and reads invoices only. Payers pay from their own wallet.

📖 **Docs:** https://becomingmountains.github.io/req-invoice-mcp/ (source in [`site/`](site/))

> Unofficial community project. Not affiliated with or endorsed by Request Network.

## Tools

| Tool | What it does |
|---|---|
| `create_payment_link` | Bill someone and get a link they open to pay. Easiest way to get paid. |
| `create_invoice` | Create an invoice in a specific token and network, or bill in USD and get paid in crypto. |
| `check_invoice` | Paid or not, with the payment transaction. |
| `list_invoices` | Everything you've billed, paid and unpaid. |
| `get_payment_transactions` | For payers: the unsigned transactions to pay an invoice in their own wallet. |
| `find_currency` | Look up currency IDs like `USDC-base` or `ETH-sepolia-sepolia`. |

## Quick start

1. **Get a free Client ID.** Sign in at [dashboard.request.network](https://dashboard.request.network) with your wallet, set up a receiving route (network, wallet, token), then **Manage → Client IDs → Generate**. Copy the **Route ID** too.
2. **Add the server to your MCP client** (Node 20+):

```json
{
  "mcpServers": {
    "req-invoice": {
      "command": "npx",
      "args": ["-y", "github:becomingmountains/req-invoice-mcp"],
      "env": {
        "REQUEST_CLIENT_ID": "your-client-id",
        "REQUEST_ORIGIN": "https://your-allowed-domain.example",
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
| `REQUEST_ORIGIN` | with Client ID | Origin matching the Client ID's allowed domain. |
| `REQUEST_DESTINATION_ID` | for links | Your dashboard Route ID. Enables `create_payment_link`. |
| `REQUEST_PAYEE` | for `create_invoice` with an API key | Default wallet that gets paid. |
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
