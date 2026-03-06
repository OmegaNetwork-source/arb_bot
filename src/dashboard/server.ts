/**
 * HTTP server for the monitoring dashboard. Serves JSON API and static dashboard HTML.
 */
import http from 'http';
import path from 'path';
import fs from 'fs';
import { getDashboardState } from './state';
import { SUPPORTED_DEXES } from '../config/constants';

const DASHBOARD_DIR = path.join(process.cwd(), 'dashboard');

function sendJson(res: http.ServerResponse, data: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(message);
}

const MAX_PORT_ATTEMPTS = 10;

export function startDashboardServer(port: number): void {
  let currentPort = port;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (pathname === '/api/status' || pathname === '/api/state') {
      const state = getDashboardState();
      // Fixed DEX columns from our supported list (same order every time)
      const dexColumns = SUPPORTED_DEXES.filter((d) => d.enabled).map((d) => d.name);
      // Slim down for client (omit large quote objects)
      const slim = {
        walletAddress: state.walletAddress,
        walletBalanceSol: state.walletBalanceSol,
        solPriceUsd: state.solPriceUsd,
        dailyPnl: state.dailyPnl,
        paused: state.paused,
        lastUpdated: state.lastUpdated,
        metrics: state.metrics,
        watchlistCount: state.watchlist.length,
        watchlist: state.watchlist.map((t) => ({
          mint: t.mint,
          symbol: t.symbol,
          name: t.name,
          priceUsd: t.priceUsd,
          volume24hUsd: t.volume24hUsd,
        })),
        dexColumns,
        tokenDexPrices: state.tokenDexPrices.map((r) => ({
          token: r.token,
          prices: r.prices,
          minPriceUsd: r.minPriceUsd,
          maxPriceUsd: r.maxPriceUsd,
          spreadPct: r.spreadPct,
          status: r.status,
        })),
        recentOpportunities: state.recentOpportunities.map((o) => ({
          id: o.id,
          token: o.token,
          buyDex: o.buyDex,
          sellDex: o.sellDex,
          inputAmountSol: o.inputAmountSol,
          netProfitSol: o.netProfitSol,
          profitPct: o.profitPct,
          detectedAt: o.detectedAt,
        })),
        recentTrades: state.recentTrades,
      };
      return sendJson(res, slim);
    }

    if (pathname === '/api/metrics') {
      return sendJson(res, getDashboardState().metrics ?? {});
    }

    if (pathname === '/api/watchlist') {
      return sendJson(res, getDashboardState().watchlist);
    }

    if (pathname === '/api/opportunities') {
      return sendJson(res, getDashboardState().recentOpportunities);
    }

    if (pathname === '/api/trades') {
      return sendJson(res, getDashboardState().recentTrades);
    }

    // Serve dashboard HTML
    if (pathname === '/' || pathname === '/index.html') {
      const file = path.join(DASHBOARD_DIR, 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) {
          sendError(res, 404, 'Dashboard not found. Run from project root.');
          return;
        }
        sendHtml(res, data.toString());
      });
      return;
    }

    sendError(res, 404, 'Not found');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && currentPort - port < MAX_PORT_ATTEMPTS) {
      currentPort++;
      server.listen(currentPort);
    } else {
      console.error(`Dashboard: could not bind to port ${currentPort}:`, err.message);
    }
  });

  server.listen(currentPort, () => {
    console.log(`Dashboard: http://localhost:${currentPort}`);
  });
}
