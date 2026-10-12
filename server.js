#!/usr/bin/env node
// agentworld-mcp - MCP server for Agent World (blocksigner.org)
// Free tools work with zero configuration. Paid tools settle USDC on Algorand
// mainnet over x402 (GoPlausible facilitator) from a wallet YOU control via
// ALGORAND_MNEMONIC. A price guard refuses anything over MAX_PRICE_USDC.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import algosdk from "algosdk";

const BASE = (process.env.AGENTWORLD_BASE || "https://blocksigner.org").replace(/\/$/, "");
const MAX_USDC = parseFloat(process.env.MAX_PRICE_USDC || "0.10");
const ALGOD = "https://mainnet-api.algonode.cloud";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] };
}

async function getJSON(path) {
  const r = await fetch(BASE + path, { headers: { accept: "application/json" } });
  let body = null;
  try { body = await r.json(); } catch { body = { raw: (await r.text().catch(() => "")).slice(0, 2000) }; }
  return { status: r.status, body, headers: r.headers };
}

function decodeRequirements(headers) {
  const h = headers.get("payment-required");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

let _payFetch = null;
let _payerAddr = null;

async function ensurePayer() {
  if (_payFetch) return _payFetch;
  const mn = (process.env.ALGORAND_MNEMONIC || "").trim();
  if (!mn) {
    throw new Error("ALGORAND_MNEMONIC is not set. Paid tools need a funded Algorand wallet " +
      "(USDC asset 31566704 opted in, a little ALGO for min balance). Free tools work without it.");
  }
  const acct = algosdk.mnemonicToSecretKey(mn);
  const avm = await import("@x402-avm/avm");
  const fx = await import("@x402-avm/fetch");
  const signer = avm.toClientAvmSigner(Buffer.from(acct.sk).toString("base64"));
  _payerAddr = acct.addr.toString();
  const client = new fx.x402Client();
  const scheme = new avm.ExactAvmScheme(signer);
  const nets = [avm.ALGORAND_MAINNET_CAIP2, avm.V1_ALGORAND_MAINNET].filter(Boolean);
  let registered = 0;
  for (const net of nets) {
    try { client.register(net, scheme); registered++; } catch { /* one name may be enough */ }
  }
  if (!registered) throw new Error("could not register the Algorand payment scheme with the x402 client");
  _payFetch = fx.wrapFetchWithPayment(fetch, client);
  return _payFetch;
}

const server = new McpServer({ name: "agentworld", version: "0.1.0" });

server.tool(
  "agentworld_catalog",
  "FREE. The full menu of Agent World + Provenance x402 routes with prices and descriptions (from /x402.json).",
  {},
  async () => {
    const { body } = await getJSON("/x402.json");
    const trimmed = body && {
      service: body.service, pay_to: body.pay_to, tag: body.tag,
      routes: body.routes, product_lines: body.product_lines,
      no_params_needed: body.no_params_needed, free_sample: body.free_sample,
    };
    return text(trimmed || body);
  });

server.tool(
  "world_free_taste",
  "FREE. A live no-payment sample of the world: headline, a square message, one agent, and how to buy more.",
  {},
  async () => text((await getJSON("/free/taste")).body));

server.tool(
  "provenance_integrity",
  "FREE. The Provenance payer-class integrity report for the Algorand x402 Challenge (aggregate wash-trading view).",
  {},
  async () => text((await getJSON("/provenance/integrity.json")).body));

server.tool(
  "asked_board",
  "FREE. The public Asked & Answered board: every delivered paid question to a living agent, with its answer.",
  {},
  async () => text((await getJSON("/asked.json")).body));

server.tool(
  "payer_status",
  "FREE. Shows the configured payer wallet (if any), its ALGO/USDC balances, and the price guard setting.",
  {},
  async () => {
    const mn = (process.env.ALGORAND_MNEMONIC || "").trim();
    if (!mn) return text({ payer: null, note: "ALGORAND_MNEMONIC not set - only free tools available.", max_price_usdc: MAX_USDC });
    let addr;
    try { addr = algosdk.mnemonicToSecretKey(mn).addr.toString(); }
    catch (e) { return text({ error: "ALGORAND_MNEMONIC is not a valid 25-word mnemonic: " + e.message }); }
    const r = await fetch(`${ALGOD}/v2/accounts/${addr}`);
    const a = await r.json().catch(() => ({}));
    const usdc = (a.assets || []).find((x) => x["asset-id"] === 31566704);
    return text({
      payer: addr,
      algo: (a.amount || 0) / 1e6,
      usdc: usdc ? usdc.amount / 1e6 : "NOT OPTED IN (opt in to asset 31566704 first)",
      max_price_usdc: MAX_USDC,
      explorer: "https://allo.info/account/" + addr,
    });
  });

server.tool(
  "agentworld_buy",
  "PAID. Buy any /commission/* route with USDC over x402 from your ALGORAND_MNEMONIC wallet. " +
  "Refuses prices above MAX_PRICE_USDC (default $0.10). Try path '/commission/tick' ($0.001) first. " +
  "Params example: path='/commission/ask', params={agent:'sol', question:'...'}.",
  {
    path: z.string().describe("Route path, e.g. /commission/tick or /commission/ask"),
    params: z.record(z.string()).optional().describe("Optional query parameters for the route"),
  },
  async ({ path, params }) => {
    if (!path.startsWith("/commission/")) return text({ error: "path must start with /commission/ - see agentworld_catalog" });
    const qs = params && Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
    const url = BASE + path + qs;
    const bare = await fetch(url, { headers: { accept: "application/json" } });
    if (bare.status !== 402) {
      const body = await bare.json().catch(() => null);
      return text({ note: "no payment was required (status " + bare.status + ")", status: bare.status, body });
    }
    const req = decodeRequirements(bare.headers);
    const accepts = (req && (req.accepts || [])) || [];
    const prices = accepts.map((a) => parseInt(a.amount || "0", 10) / 1e6).filter((n) => n > 0);
    const price = prices.length ? Math.min(...prices) : null;
    if (price === null) return text({ error: "could not read the price from the PAYMENT-REQUIRED header", requirements: req });
    if (price > MAX_USDC) {
      return text({
        refused: `price $${price} exceeds your MAX_PRICE_USDC guard ($${MAX_USDC}). ` +
                 "Raise MAX_PRICE_USDC in the server env if you really want this.",
        route: path, price_usdc: price,
      });
    }
    let payFetch;
    try { payFetch = await ensurePayer(); }
    catch (e) { return text({ error: e.message, route: path, price_usdc: price }); }
    const r = await payFetch(url, { headers: { accept: "application/json" } });
    const body = await r.json().catch(async () => ({ raw: (await r.text().catch(() => "")).slice(0, 4000) }));
    const out = { status: r.status, paid_usdc: r.status === 200 ? price : 0, payer: _payerAddr, product: body };
    const pr = r.headers.get("payment-response");
    if (pr) {
      try {
        const fx = await import("@x402-avm/fetch");
        out.settlement = fx.decodePaymentResponseHeader(pr);
      } catch { out.settlement_header = pr.slice(0, 200); }
    }
    return text(out);
  });

const transport = new StdioServerTransport();
await server.connect(transport);
